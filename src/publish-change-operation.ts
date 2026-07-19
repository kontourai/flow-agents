import { isDeepStrictEqual } from "node:util";
import * as path from "node:path";
import { withSubjectLockAsync } from "./cli/assignment-provider.js";
import { resolveEffectiveChangeProviderSettings } from "./cli/effective-change-provider-settings.js";
import { createGithubChangeProvider, resolveTrustedGithubExecutable } from "./cli/github-change-provider.js";
import type { ChangeProviderRequest } from "./cli/change-provider.js";
import type { ChangeProviderSettings } from "./cli/public-contracts.js";
import { resolveTrustedLocalGitCommit } from "./lib/trusted-git.js";
import {
  assertAuthenticatedPublishChangeObservation,
  assertIssuedPublishChangeAction,
  type AuthenticatedPublishChangeObservation,
  type IssuedPublishChangeAction,
  type PublishChangeIntent,
} from "./publish-change-operation-authority.js";

export type PublishChangeSessionInput = { sessionDir: string };

export type ExecutePublishChangeOperationInput = PublishChangeSessionInput & {
  intent: PublishChangeIntent;
};

export type CompletePublishChangeOperationInput = PublishChangeSessionInput & {
  action: IssuedPublishChangeAction;
};

type SessionContext = {
  sessionDir: string;
  artifactRoot: string;
  projectRoot: string;
  slug: string;
};

/**
 * The Flow runtime owns canonical state, persistence, and projection. This
 * narrow dependency boundary keeps this module responsible only for the
 * authenticated provider transaction: issue, observe outside the lock, then
 * re-bind and commit under the subject lock.
 */
export type PublishChangeOperationDependencies<Result, Run> = {
  resolveSessionContext: (sessionDir: string) => SessionContext;
  currentAction: (context: SessionContext, intent: PublishChangeIntent) => Promise<IssuedPublishChangeAction>;
  assertTrustedHead: (context: SessionContext, action: IssuedPublishChangeAction) => void;
  hasCommittedReceipt: (context: SessionContext, action: IssuedPublishChangeAction) => Promise<boolean>;
  recoverCommitted: (context: SessionContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation) => Promise<Result | null>;
  persistResult: (context: SessionContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation) => { sha256: string };
  advanceGate: (context: SessionContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, sha256: string) => Promise<Run>;
  projectCompleted: (context: SessionContext, action: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, run: Run) => Result;
  operationStaleError: () => Error;
};

export async function issuePublishChangeOperation<Result, Run>(input: ExecutePublishChangeOperationInput, dependencies: PublishChangeOperationDependencies<Result, Run>): Promise<IssuedPublishChangeAction> {
  const context = dependencies.resolveSessionContext(input.sessionDir);
  return await withSubjectLockAsync(context.artifactRoot, context.slug, async () => await dependencies.currentAction(context, input.intent));
}

export async function executePublishChangeOperation<Result, Run>(input: ExecutePublishChangeOperationInput, dependencies: PublishChangeOperationDependencies<Result, Run>): Promise<Result> {
  resolveTrustedGithubExecutable();
  const context = dependencies.resolveSessionContext(input.sessionDir);
  const trustedHeadSha = resolveTrustedLocalGitCommit(context.projectRoot, input.intent.head_ref);
  if (trustedHeadSha !== input.intent.head_sha.toLowerCase()) {
    throw new Error("publish-change intent head SHA does not match the trusted local head ref");
  }
  const action = await issuePublishChangeOperation(input, dependencies);
  const effective = resolveEffectiveChangeProviderSettings(context.projectRoot, path.join(context.projectRoot, "context", "settings", "change-provider-settings.json"));
  if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") {
    throw new Error("publish-change execute requires a configured ChangeProvider for this repository");
  }
  const provider = createGithubChangeProvider(effective.provider as ChangeProviderSettings, action.provider.configuration_id);
  return await completePublishChangeOperation({ sessionDir: input.sessionDir, action }, async (issued) => {
    const { action_id: _actionId, ...request } = issued;
    return await provider.createOrRecover(request as ChangeProviderRequest);
  }, dependencies);
}

export async function completePublishChangeOperation<Result, Run>(
  input: CompletePublishChangeOperationInput,
  observe: (request: IssuedPublishChangeAction) => AuthenticatedPublishChangeObservation | Promise<AuthenticatedPublishChangeObservation>,
  dependencies: PublishChangeOperationDependencies<Result, Run>,
): Promise<Result> {
  const context = dependencies.resolveSessionContext(input.sessionDir);
  const issued = assertIssuedPublishChangeAction(input.action);
  await withSubjectLockAsync(context.artifactRoot, context.slug, async () => {
    await assertCurrentOrRecoverable(context, issued, dependencies);
  });
  const observation = assertAuthenticatedPublishChangeObservation(issued, await observe(structuredClone(issued)));
  return await withSubjectLockAsync(context.artifactRoot, context.slug, async () => {
    // Provider I/O deliberately happened outside this lock. Bind the observed
    // record back to the currently trusted local ref while Flow owns commit.
    dependencies.assertTrustedHead(context, issued);
    const recovery = await recoverIfCommitted(context, issued, observation, dependencies);
    if (recovery) return recovery;
    const current = await dependencies.currentAction(context, intentFromAction(issued));
    if (!isDeepStrictEqual(current, issued)) throw dependencies.operationStaleError();
    const persisted = dependencies.persistResult(context, issued, observation);
    const run = await dependencies.advanceGate(context, issued, observation, persisted.sha256);
    return dependencies.projectCompleted(context, issued, observation, run);
  });
}

async function assertCurrentOrRecoverable<Result, Run>(context: SessionContext, issued: IssuedPublishChangeAction, dependencies: PublishChangeOperationDependencies<Result, Run>): Promise<void> {
  try {
    const current = await dependencies.currentAction(context, intentFromAction(issued));
    if (!isDeepStrictEqual(current, issued)) throw dependencies.operationStaleError();
  } catch (error) {
    if (!await dependencies.hasCommittedReceipt(context, issued)) throw error;
  }
}

async function recoverIfCommitted<Result, Run>(context: SessionContext, issued: IssuedPublishChangeAction, observation: AuthenticatedPublishChangeObservation, dependencies: PublishChangeOperationDependencies<Result, Run>): Promise<Result | null> {
  if (!await dependencies.hasCommittedReceipt(context, issued)) return null;
  return await dependencies.recoverCommitted(context, issued, observation);
}

function intentFromAction(action: IssuedPublishChangeAction): PublishChangeIntent {
  return {
    title: action.intent.title,
    body: action.intent.body,
    ...(action.intent.draft === undefined ? {} : { draft: action.intent.draft }),
    base_ref: action.base_ref,
    head_ref: action.head_ref,
    head_sha: action.head_sha,
  };
}
