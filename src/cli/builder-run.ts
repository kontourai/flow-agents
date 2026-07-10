import { flagString, parseArgs } from "../lib/args.js";
import { recoverBuilderFlowSession, startBuilderFlowSession, syncBuilderFlowSession } from "../builder-flow-runtime.js";

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const action = parsed.positionals[0];
  const sessionDir = flagString(parsed.flags, "session-dir");
  const validRecoveryArguments = parsed.positionals.length === 1
    && Object.keys(parsed.flags).length === 1
    && typeof parsed.flags["session-dir"] === "string";
  if (action === "recover" && !validRecoveryArguments) {
    console.error("Usage: flow-agents builder-run <start|sync|recover> --session-dir <path>");
    return 64;
  }
  if (!sessionDir) {
    console.error("builder-run requires --session-dir .kontourai/flow-agents/<slug>");
    return 64;
  }
  if (action !== "start" && action !== "sync" && action !== "recover") {
    console.error("Usage: flow-agents builder-run <start|sync|recover> --session-dir <path>");
    return 64;
  }
  const result = action === "start"
    ? await startBuilderFlowSession({ sessionDir })
    : action === "sync"
      ? await syncBuilderFlowSession({ sessionDir })
      : await recoverBuilderFlowSession({ sessionDir });
  console.log(JSON.stringify({
    run_id: result.run.runId,
    definition_id: result.run.definitionId,
    current_step: result.run.state.current_step,
    status: result.run.state.status,
    attached: result.attached,
    next_action: result.projection.next_action,
  }));
  return 0;
}
