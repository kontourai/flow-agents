import { flagString, parseArgs } from "../lib/args.js";
import {
  cancelBuilderFlowSession,
  archiveBuilderFlowSession,
  pauseBuilderFlowSession,
  recoverBuilderFlowSession,
  releaseBuilderFlowAssignment,
  resumeBuilderFlowSession,
} from "../builder-flow-runtime.js";

const USAGE = "Usage: flow-agents builder-run <recover|pause|resume|cancel|release-assignment|archive> --session-dir <path> [--reason <text> | --authorization-file <path>]";

export async function main(argv: string[]): Promise<number> {
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
              ? await cancelBuilderFlowSession({ sessionDir, authorizationFile: authorizationFile! })
              : action === "release-assignment"
                ? await releaseBuilderFlowAssignment({ sessionDir, reason: reason! })
                : await archiveBuilderFlowSession({ sessionDir, authorizationFile: authorizationFile! });
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
