import * as fs from "node:fs";
import { flagString, parseArgs } from "../lib/args.js";
import {
  cancelBuilderFlowSession,
  archiveBuilderFlowSession,
  withLifecycleAuthorityTestSource,
  pauseBuilderFlowSession,
  prepareBuilderCancelRequest,
  recoverBuilderFlowSession,
  releaseBuilderFlowAssignment,
  resumeBuilderFlowSession,
} from "../builder-flow-runtime.js";
import type { LifecycleAuthorityTestSource } from "../builder-lifecycle-authority.js";

const USAGE = "Usage: flow-agents builder-run <recover|pause|resume|cancel|cancel-request|release-assignment|archive> --session-dir <path> [--reason <text> | --authorization-file <path>]";
const CANCEL_REQUEST_USAGE = "Usage: flow-agents builder-run cancel-request --session-dir <path> [--out <file>] [--reason <text>] [--actor <name>] [--expires-in-hours <n>]";

/**
 * `cancel-request` (#659 Slice C) — mint a ready-to-sign cancel authorization so
 * an operator no longer hand-assembles the JSON. READ-ONLY: it signs and cancels
 * nothing; the ed25519 signature lock is unchanged. The operator signs the
 * emitted `signing_payload`, drops the signature into the written file, and runs
 * `builder-run cancel --authorization-file <file>` as before.
 */
async function runCancelRequest(sessionDir: string, flags: Record<string, string | boolean | string[]>): Promise<number> {
  const allowed = new Set(["session-dir", "out", "reason", "actor", "expires-in-hours"]);
  if (Object.keys(flags).some((name) => !allowed.has(name))) {
    console.error(CANCEL_REQUEST_USAGE);
    return 64;
  }
  const expiresRaw = flagString(flags, "expires-in-hours");
  let expiresInHours: number | undefined;
  if (expiresRaw !== undefined) {
    expiresInHours = Number(expiresRaw);
    // Upper-bound it (1 year) so a pathological value can't overflow the Date
    // math into an Invalid Date / uncaught RangeError; return the usual usage code.
    if (!Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > 8760) {
      console.error("builder-run cancel-request --expires-in-hours must be a positive number of at most 8760 (1 year)");
      return 64;
    }
  }
  const prepared = await prepareBuilderCancelRequest({
    sessionDir,
    reason: flagString(flags, "reason"),
    requestActor: flagString(flags, "actor"),
    expiresInHours,
  });
  const outFile = flagString(flags, "out") ?? prepared.suggestedOutFile;
  // Symlink-safe write, matching this codebase's O_NOFOLLOW pattern for writes
  // into session dirs (recordAuthorizationConsumed / writeExistingFileNoFollow):
  // never follow a symlink planted at the target and clobber it.
  const fd = fs.openSync(outFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(prepared.authorization, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  console.log(JSON.stringify({
    run_id: prepared.runId,
    subject: prepared.subject,
    run_status: prepared.runStatus,
    already_terminal: prepared.alreadyTerminal,
    unsigned_authorization_file: outFile,
    signing_payload: prepared.signingPayload,
    next_steps: [
      `Sign the exact bytes in "signing_payload" with your ed25519 lifecycle-authority key (base64).`,
      `Add a "signature" block: {"algorithm":"ed25519","key_id":"<your registry key id>","value":"<base64 signature>"} to ${outFile}, and save it as the signed authorization file.`,
      `Run: flow-agents builder-run cancel --session-dir ${sessionDir} --authorization-file <signed file>`,
      `The signature is verified against the externally provisioned lifecycle-authority registry; repository files and Git refs are never authority roots.`,
    ],
    ...(prepared.alreadyTerminal ? { note: `Run is already ${prepared.runStatus}; cancel would be a no-op.` } : {}),
  }, null, 2));
  return 0;
}

export async function main(argv: string[], testAuthoritySource?: LifecycleAuthorityTestSource): Promise<number> {
  const parsed = parseArgs(argv);
  const action = parsed.positionals[0];
  const sessionDir = flagString(parsed.flags, "session-dir");
  const authorizationFile = flagString(parsed.flags, "authorization-file");
  const reason = flagString(parsed.flags, "reason");
  const validRecoveryArguments = parsed.positionals.length === 1
    && Object.keys(parsed.flags).length === 1
    && typeof parsed.flags["session-dir"] === "string";
  if (action === "recover" && !validRecoveryArguments) {
    console.error(USAGE);
    return 64;
  }
  if (!sessionDir) {
    console.error("builder-run requires --session-dir .kontourai/flow-agents/<slug>");
    return 64;
  }
  // cancel-request is a READ-ONLY authorization generator with its own flag set;
  // handle it before the mutation-lifecycle validation below.
  if (action === "cancel-request") {
    if (parsed.positionals.length !== 1) {
      console.error(CANCEL_REQUEST_USAGE);
      return 64;
    }
    return await runCancelRequest(sessionDir, parsed.flags);
  }
  if (!action || !["recover", "pause", "resume", "cancel", "release-assignment", "archive"].includes(action)) {
    console.error(USAGE);
    return 64;
  }
  const agentLifecycle = action === "pause" || action === "resume" || action === "release-assignment";
  const authorizedLifecycle = action === "cancel" || action === "archive";
  const lifecycle = agentLifecycle || authorizedLifecycle;
  const allowedLifecycleFlag = (name: string) => name === "session-dir" || (agentLifecycle ? name === "reason" : name === "authorization-file");
  if (lifecycle && (parsed.positionals.length !== 1 || Object.keys(parsed.flags).some((name) => !allowedLifecycleFlag(name)))) {
    console.error(USAGE);
    return 64;
  }
  if (agentLifecycle && !reason) {
    console.error(`builder-run ${action} requires --reason <text>`);
    return 64;
  }
  if (authorizedLifecycle && !authorizationFile) {
    console.error(`builder-run ${action} requires a signed --authorization-file <path>`);
    return 64;
  }
  if (!lifecycle && (authorizationFile || reason)) {
    console.error(USAGE);
    return 64;
  }
  const result = action === "recover"
        ? await recoverBuilderFlowSession({ sessionDir })
        : action === "pause"
          ? await pauseBuilderFlowSession({ sessionDir, reason: reason! })
          : action === "resume"
            ? await resumeBuilderFlowSession({ sessionDir, reason: reason! })
            : action === "cancel"
              ? await cancelBuilderFlowSession(testAuthoritySource ? withLifecycleAuthorityTestSource({ sessionDir, authorizationFile: authorizationFile! }, testAuthoritySource) : { sessionDir, authorizationFile: authorizationFile! })
              : action === "release-assignment"
                ? await releaseBuilderFlowAssignment({ sessionDir, reason: reason! })
                : await archiveBuilderFlowSession(testAuthoritySource ? withLifecycleAuthorityTestSource({ sessionDir, authorizationFile: authorizationFile! }, testAuthoritySource) : { sessionDir, authorizationFile: authorizationFile! });
  console.log(JSON.stringify({
    run_id: result.run.runId,
    definition_id: result.run.definitionId,
    current_step: result.run.state.current_step,
    status: result.run.state.status,
    attached: result.attached,
    ...(action === "cancel" ? {
      assignment_released: "assignmentReleased" in result ? result.assignmentReleased : false,
      idempotent: "idempotent" in result ? result.idempotent : false,
    } : action === "release-assignment" ? {
      assignment_released: "assignmentReleased" in result ? result.assignmentReleased : false,
    } : action === "archive" ? {
      archive_dir: "archiveDir" in result ? result.archiveDir : null,
    } : {}),
    next_action: result.projection.next_action,
  }));
  return 0;
}
