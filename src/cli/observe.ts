/**
 * `flow-agents observe` — the optional observe-mode query and runner (docs/decisions/observe-mode.md).
 *
 *   status  read-only "what's left": the facts the Stop hook would evaluate, the engagement check,
 *           and the lock digest. It locks nothing, runs nothing, and never counts as a reminder.
 *   verify  runs every locked check that has no result at the current commit through the
 *           writer-observed runner, without the Stop hook's time budget. This is the agent running
 *           its checks, not a submission: the observation lands in the same hash-chained command log.
 *
 * Neither verb is ever required to pass anything; the Stop hook evaluates the same facts itself.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { currentWorkflowSessionDir, findRepoRootFromDir } from "./workflow-sidecar.js";
import { definitionIsObserved, evaluateObserveRun } from "../observe-mode.js";

const requireCjs = createRequire(import.meta.url);

type Engagement = {
  hostRuntime: (env?: NodeJS.ProcessEnv) => string;
  hostStopCapability: (runtime: string) => { blocks: boolean | null; note: string };
};

function engagement(): Engagement {
  return requireCjs(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/observe-engagement.js")) as Engagement;
}

function usage(): number {
  console.log("Usage: flow-agents observe <status|verify> [--session-dir <dir>] [--json]");
  console.log("");
  console.log("  status  Read-only: what is still unmet for the current observe run. Never required.");
  console.log("  verify  Run the locked checks that have no result at the current commit (no Stop budget).");
  return 0;
}

function resolveSession(sessionFlag: string | undefined): { projectRoot: string; sessionDir: string } {
  if (sessionFlag) {
    const sessionDir = path.resolve(sessionFlag);
    if (!fs.existsSync(sessionDir)) throw new Error(`observe: session directory not found: ${sessionDir}`);
    return { projectRoot: findRepoRootFromDir(sessionDir), sessionDir };
  }
  const projectRoot = findRepoRootFromDir(process.cwd());
  const sessionDir = currentWorkflowSessionDir(path.join(projectRoot, ".kontourai", "flow-agents"));
  if (!sessionDir) throw new Error("observe: no current workflow session for this actor; pass --session-dir <dir>");
  return { projectRoot, sessionDir };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") return usage();
  if (verb !== "status" && verb !== "verify") {
    console.error(`observe: unknown verb ${JSON.stringify(verb)}`);
    usage();
    return 64;
  }
  const parsed = parseArgs(rest);
  const json = flagBool(parsed.flags, "json");
  let session: { projectRoot: string; sessionDir: string };
  try {
    session = resolveSession(flagString(parsed.flags, "session-dir"));
  } catch (error) {
    console.error((error as Error).message);
    return 66;
  }
  const slug = path.basename(session.sessionDir);
  const definitionFile = path.join(session.projectRoot, ".kontourai", "flow", "runs", slug, "definition.json");
  let definition: unknown = null;
  try { definition = JSON.parse(fs.readFileSync(definitionFile, "utf8")); } catch { /* reported below */ }
  if (!definitionIsObserved(definition)) {
    console.error(`observe: ${slug} is not an observe-mode run (its pinned definition does not declare evidence_mode "observed")`);
    return 65;
  }
  const decision = await evaluateObserveRun({ projectRoot: session.projectRoot, sessionDir: session.sessionDir, mode: verb });
  const eng = engagement();
  const runtime = eng.hostRuntime(process.env);
  const capability = eng.hostStopCapability(runtime);
  if (json) {
    console.log(JSON.stringify({
      session: slug,
      mode: verb,
      satisfied: decision.action === "satisfied",
      gate: decision.gate,
      facts: decision.facts,
      head: decision.head,
      base: decision.base,
      lock_digest: decision.lock_digest,
      reruns: decision.reruns,
      latency_ms: decision.latency_ms,
      engagement: { observe_mode: true, host: runtime, stop_blocks: capability.blocks, note: capability.note },
    }, null, 2));
  } else {
    console.log(`Observe mode: active · host ${runtime}: ${capability.note}`);
    console.log(decision.message);
    for (const rerun of decision.reruns) console.log(`ran ${rerun.command}: ${rerun.outcome} (${rerun.ms} ms)`);
  }
  return decision.action === "hard" ? 70 : 0;
}
