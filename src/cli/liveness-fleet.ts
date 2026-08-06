/**
 * liveness-fleet.ts — `flow-agents liveness-fleet` (#1021).
 *
 * The read surface ADR 0021's liveness leg never had. Thin by design: every decision lives in
 * `src/lib/liveness-fleet.ts` so Console and any other plane consume the same primitive rather
 * than a second implementation of "is this lane live".
 *
 * @module
 */
import { flagBool, flagList, parseArgs } from "../lib/args.js";
import { type FleetLane, discoverRepoRoots, readFleet } from "../lib/liveness-fleet.js";

function printHelp(): void {
  console.log("Usage: flow-agents liveness-fleet [options]");
  console.log("");
  console.log("Report every liveness lane across the scanned repo roots: who holds what, and whether the lease is still live (issue #1021).");
  console.log("");
  console.log("Options:");
  console.log("  --root <path>          Repo root to scan; repeatable. Default: this repo plus SA_PROTECTED_WORKSPACE_ROOTS");
  console.log("  --state <state>        Only show lanes in this state (held|reclaimable|released); repeatable");
  console.log("  --subject <id>         Only show lanes for this subject id; repeatable");
  console.log("  --no-stranded          Skip worktree-private streams stranded by the pre-#1020 emit path");
  console.log("  --json                 Print the full scan result as JSON");
  console.log("  --help                 Show this help");
  console.log("");
  console.log("States are the LIVENESS leg only. ADR 0021's effective state is a join with durable");
  console.log("assignment (`assignment-provider status`); neither leg is authoritative alone.");
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? "-" : "";
  if (abs < 90) return `${sign}${abs}s`;
  if (abs < 5400) return `${sign}${Math.round(abs / 60)}m`;
  if (abs < 172800) return `${sign}${Math.round(abs / 3600)}h`;
  return `${sign}${Math.round(abs / 86400)}d`;
}

function renderTable(lanes: FleetLane[]): void {
  if (lanes.length === 0) {
    console.log("No liveness lanes found in the scanned roots.");
    return;
  }
  const rows = lanes.map((lane) => ({
    state: lane.state + (lane.stranded ? " *" : ""),
    age: formatAge(lane.ageSeconds),
    ttl: `${lane.ttlSeconds}s`,
    subject: lane.subjectId,
    actor: lane.actor,
  }));
  const width = (key: keyof (typeof rows)[number]) => Math.max(key.length, ...rows.map((row) => row[key].length));
  const widths = { state: width("state"), age: width("age"), ttl: width("ttl"), subject: width("subject"), actor: width("actor") };
  const line = (row: (typeof rows)[number]) =>
    [row.state.padEnd(widths.state), row.age.padStart(widths.age), row.ttl.padStart(widths.ttl), row.subject.padEnd(widths.subject), row.actor].join("  ");

  console.log(line({ state: "STATE", age: "AGE", ttl: "TTL", subject: "SUBJECT", actor: "ACTOR" }));
  for (const row of rows) console.log(line(row));
}

export function main(argv = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  if (flagBool(parsed.flags, "help")) {
    printHelp();
    return 0;
  }

  const explicitRoots = flagList(parsed.flags, "root");
  const states = new Set(flagList(parsed.flags, "state"));
  const subjects = new Set(flagList(parsed.flags, "subject"));
  const asJson = flagBool(parsed.flags, "json");

  const result = readFleet({
    roots: explicitRoots.length > 0 ? explicitRoots : undefined,
    includeStrandedStreams: !flagBool(parsed.flags, "no-stranded"),
  });

  const lanes = result.lanes.filter((lane) => (states.size === 0 || states.has(lane.state)) && (subjects.size === 0 || subjects.has(lane.subjectId)));

  if (asJson) {
    console.log(JSON.stringify({ ...result, lanes }, null, 2));
  } else {
    renderTable(lanes);
    if (lanes.some((lane) => lane.stranded)) {
      console.log("");
      console.log("* stranded in a worktree-private stream (pre-#1020 emit path); readers anchored on the shared root will not see it.");
    }
    // Warnings go to stderr and are never suppressed: a fleet view that silently omits a root
    // it could not read is indistinguishable from one where that root is genuinely idle.
    for (const warning of result.warnings) process.stderr.write(`[liveness-fleet] ${warning.root}: ${warning.detail}\n`);
    if (result.streams.length === 0) {
      process.stderr.write(`[liveness-fleet] no liveness streams found under: ${result.roots.join(", ") || "(no roots resolved)"}\n`);
    }
  }
  return 0;
}

export { discoverRepoRoots };
