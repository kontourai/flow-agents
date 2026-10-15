import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeProviderSettings } from "./public-contracts.js";
import { resolveEffectiveChangeProviderSettings } from "./effective-change-provider-settings.js";
import { observeGithubMergedChange, type GithubMergedChangeObservation } from "./github-change-provider.js";
import { execTrustedGitSync } from "../lib/trusted-git.js";
import { expectationsForGate, loadFlowConfig, validateRunStateConsistency, type FlowDefinition } from "@kontourai/flow";

const MAX_PROVIDER_RESULT_BYTES = 65_536;
const MAX_FLOW_RUN_FILE_BYTES = 4 * 1024 * 1024;
const SHA = /^[0-9a-f]{40,64}$/u;

type PublishedChange = Readonly<{
  repository: { owner: string; name: string };
  provider: { kind: "github"; configurationId: string };
  change: {
    number: number;
    state: "open" | "merged";
    baseRef: string;
    headRef: string;
    headSha: string;
  };
  providerActor: string;
}>;

export type WorktreeReclaimReceipt = Readonly<{
  schema_version: "1.0";
  outcome: "reclaimed";
  repository: { owner: string; name: string };
  branch: string;
  head_sha: string;
  merge_sha: string;
  provider_actor: string;
  observed_at: string;
  reclaimed_at: string;
}>;

export type WorktreeReclaimDependencies = Readonly<{
  observeMergedChange?: (input: Readonly<{
    settings: ChangeProviderSettings;
    configurationId: string;
    expected: {
      number: number;
      repository: { owner: string; name: string };
      baseRef: string;
      headRef: string;
      headSha: string;
      providerActor: string;
    };
  }>) => Promise<GithubMergedChangeObservation>;
  now?: () => string;
}>;

/**
 * Remove only a clean, registered, non-primary worktree whose exact head has a
 * fresh authenticated merged observation. The branch is deliberately retained.
 */
export async function reclaimBuilderWorktree(
  sessionDirInput: string,
  dependencies: WorktreeReclaimDependencies = {},
): Promise<WorktreeReclaimReceipt> {
  const sessionDir = realDirectory(sessionDirInput, "session directory");
  const worktree = realDirectory(String(execTrustedGitSync(sessionDir, ["rev-parse", "--show-toplevel"])).trim(), "worktree");
  const commonDirText = String(execTrustedGitSync(worktree, ["rev-parse", "--git-common-dir"])).trim();
  const commonDir = fs.realpathSync(path.resolve(worktree, commonDirText));
  const primaryRoot = fs.realpathSync(path.dirname(commonDir));
  if (worktree === primaryRoot) throw new Error("builder-run reclaim refuses the primary repository checkout");
  if (!containsPath(worktree, sessionDir)) throw new Error("builder-run reclaim session is not inside the target worktree");
  assertRegisteredWorktree(primaryRoot, worktree);
  const dirty = String(execTrustedGitSync(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
  if (dirty) throw new Error("builder-run reclaim refuses a dirty worktree");

  await assertLearningComplete(sessionDir);
  const published = readPublishedChange(sessionDir);
  const headSha = String(execTrustedGitSync(worktree, ["rev-parse", "--verify", "HEAD^{commit}"])).trim().toLowerCase();
  const branch = String(execTrustedGitSync(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  if (published.change.headSha !== headSha || published.change.headRef !== branch) {
    throw new Error("builder-run reclaim worktree HEAD does not match the published change");
  }
  const effective = resolveEffectiveChangeProviderSettings(primaryRoot);
  if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") {
    throw new Error("builder-run reclaim requires the configured ChangeProvider");
  }
  const settings = effective.provider as ChangeProviderSettings;
  const observe = dependencies.observeMergedChange
    ?? ((input) => observeGithubMergedChange(input));
  const observation = await observe({
    settings,
    configurationId: published.provider.configurationId,
    expected: {
      number: published.change.number,
      repository: published.repository,
      baseRef: published.change.baseRef,
      headRef: published.change.headRef,
      headSha: published.change.headSha,
      providerActor: published.providerActor,
    },
  });
  if (observation.state !== "merged" || observation.headSha !== headSha) {
    throw new Error("builder-run reclaim provider observation did not confirm the exact merged head");
  }

  // Non-forced removal is the final safety check Git itself provides. Never
  // delete the branch: it remains a recovery ref after the checkout is gone.
  execTrustedGitSync(primaryRoot, ["worktree", "remove", worktree]);
  execTrustedGitSync(primaryRoot, ["worktree", "prune"]);
  const receipt: WorktreeReclaimReceipt = Object.freeze({
    schema_version: "1.0",
    outcome: "reclaimed",
    repository: published.repository,
    branch,
    head_sha: headSha,
    merge_sha: observation.mergeSha,
    provider_actor: observation.providerActor,
    observed_at: observation.observedAt,
    reclaimed_at: (dependencies.now ?? (() => new Date().toISOString()))(),
  });
  writeDurableReceipt(primaryRoot, receipt);
  return receipt;
}

type LearningClaimSelector = Readonly<{ claimType: string; acceptedStatuses: readonly string[] }>;

async function assertLearningComplete(sessionDir: string): Promise<void> {
  const selectors = await terminalGateLearningSelectors(sessionDir);
  const file = path.join(sessionDir, "trust.bundle");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let root: Record<string, unknown>;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("trust bundle is not a bounded regular file");
    root = record(JSON.parse(fs.readFileSync(descriptor, "utf8")), "trust bundle");
  } finally {
    fs.closeSync(descriptor);
  }
  const claims = Array.isArray(root.claims) ? root.claims.map((claim) => record(claim, "trust bundle claim")) : [];
  for (const { claimType, acceptedStatuses } of selectors) {
    const matching = claims.filter((claim) => claim.claimType === claimType);
    const accepted = matching.length > 0
      && matching.every((claim) => acceptedStatuses.includes(String(claim.status)));
    if (!accepted) throw new Error(`builder-run reclaim requires only accepted current ${claimType} learning evidence`);
  }
}

/**
 * The learning evidence reclaim requires, taken from the run's own effective Flow definition: the
 * required trust-bundle claims of the gate on its terminal step (the step whose `next` is null),
 * after Flow applies the project configuration's expectation overrides.
 *
 * This was the literal pair `builder.learn.decisions` / `builder.learn.evidence` with the statuses
 * verified/trusted/accepted, which is exactly what Builder's composed `learn-gate` declares
 * (publish-learn.flow.json), so the derivation is identical for Builder while a kit with its own
 * closing gate and claim types gets the same check. The statuses come from the expectation's
 * `bundle_claim.accepted_statuses`, defaulting to ["verified"] as Flow's own gate evaluation does.
 *
 * Fails closed: a missing or inconsistent run, an ambiguous terminal step, or a terminal gate that
 * declares no required trust-bundle claim refuses reclaim rather than skipping the learning check.
 */
async function terminalGateLearningSelectors(sessionDir: string): Promise<LearningClaimSelector[]> {
  const artifactRoot = path.dirname(sessionDir);
  const kontouraiRoot = path.dirname(artifactRoot);
  if (path.basename(artifactRoot) !== "flow-agents" || path.basename(kontouraiRoot) !== ".kontourai") {
    throw new Error("builder-run reclaim requires a session directory at .kontourai/flow-agents/<slug>");
  }
  const runId = path.basename(sessionDir);
  const runDir = path.join(kontouraiRoot, "flow", "runs", runId);
  let definition: FlowDefinition;
  try {
    const startDefinition = record(JSON.parse(readBoundedRegularFile(path.join(runDir, "definition.json"), MAX_FLOW_RUN_FILE_BYTES)), "Flow start definition");
    const state = record(JSON.parse(readBoundedRegularFile(path.join(runDir, "state.json"), MAX_FLOW_RUN_FILE_BYTES)), "Flow state");
    definition = validateRunStateConsistency(startDefinition, state, { runId }).definition;
  } catch {
    throw new Error("builder-run reclaim requires the session's canonical Flow run definition to identify its learning evidence");
  }
  const terminal = definition.steps.filter((step) => step.next === null);
  const terminalStep = terminal.length === 1 ? terminal[0].id : undefined;
  const config = await loadFlowConfig(path.dirname(kontouraiRoot));
  const selectors: LearningClaimSelector[] = [];
  for (const [gateId, gate] of Object.entries(definition.gates ?? {})) {
    if (terminalStep === undefined || gate.step !== terminalStep) continue;
    for (const expectation of expectationsForGate({ ...gate, id: gateId }, config)) {
      const selector = expectation.bundle_claim;
      if (!expectation.required || expectation.kind !== "trust.bundle" || !selector) continue;
      const claimType = selector.claimType;
      const statuses = selector.accepted_statuses;
      if (typeof claimType !== "string" || claimType.length === 0) continue;
      selectors.push(Object.freeze({
        claimType,
        acceptedStatuses: Array.isArray(statuses) ? statuses.filter((status): status is string => typeof status === "string") : ["verified"],
      }));
    }
  }
  if (selectors.length === 0) {
    throw new Error(`builder-run reclaim requires the run's terminal gate to declare required learning evidence; ${String(definition.id)} declares none`);
  }
  return selectors;
}

function readBoundedRegularFile(file: string, maxBytes: number): string {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${path.basename(file)} is not a bounded regular file`);
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPublishedChange(sessionDir: string): PublishedChange {
  const file = path.join(sessionDir, "publish-change.result.json");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_PROVIDER_RESULT_BYTES) throw new Error("published change result is not a bounded regular file");
    bytes = fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const root = record(JSON.parse(bytes.toString("utf8")), "published change result");
  const repository = record(root.repository, "published change repository");
  const provider = record(root.provider, "published change provider");
  const change = record(root.change_ref, "published change ref");
  const owner = text(repository.owner, "repository owner", 255);
  const name = text(repository.name, "repository name", 255);
  const kind = text(provider.kind, "provider kind", 32);
  const configurationId = text(provider.configuration_id, "provider configuration id", 1_024);
  const state = text(change.state, "published change state", 16);
  const number = change.number;
  const headSha = text(change.head_sha, "published change head SHA", 64).toLowerCase();
  if (root.schema_version !== "1.0" || root.operation !== "publish-change" || kind !== "github"
    || !Number.isSafeInteger(number) || Number(number) < 1 || !["open", "merged"].includes(state) || !SHA.test(headSha)) {
    throw new Error("published change result is invalid");
  }
  return Object.freeze({
    repository: Object.freeze({ owner, name }),
    provider: Object.freeze({ kind: "github" as const, configurationId }),
    change: Object.freeze({
      number: Number(number),
      state: state as "open" | "merged",
      baseRef: text(change.base_ref, "published change base ref", 255),
      headRef: text(change.head_ref, "published change head ref", 255),
      headSha,
    }),
    providerActor: text(root.provider_actor, "provider actor", 512),
  });
}

function assertRegisteredWorktree(primaryRoot: string, worktree: string): void {
  const listing = String(execTrustedGitSync(primaryRoot, ["worktree", "list", "--porcelain", "-z"]));
  const registered = listing.split("\0").some((entry) => entry === `worktree ${worktree}`);
  if (!registered) throw new Error("builder-run reclaim target is not a registered worktree");
}

function writeDurableReceipt(primaryRoot: string, receipt: WorktreeReclaimReceipt): void {
  const id = createHash("sha256").update(`${receipt.repository.owner}/${receipt.repository.name}:${receipt.head_sha}`).digest("hex").slice(0, 24);
  const directory = path.join(primaryRoot, ".kontourai", "flow-agents", "worktree-reclaims");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `.${id}.${process.pid}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function realDirectory(value: string, label: string): string {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
