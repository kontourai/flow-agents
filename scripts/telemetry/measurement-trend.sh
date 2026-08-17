#!/usr/bin/env bash
# Render the trend for one measurement as a CHANGE report, not a score. #1258.
#
# The tempting output is "87% -> 74%". It is the wrong output. An aggregate says something
# moved without saying what, so the cheapest response is to argue with the number, and the
# cheapest fix is to move the threshold. This prints the probes whose verdict actually
# changed between the two most recent readings, and stays silent about the ones that did not.
#
# Advisory only. Nothing here exits non-zero because a reading got worse — this is an
# instrument, not a gate. Gating on a count is the antipattern #1258 was filed to avoid.
#
# Usage: measurement-trend.sh --measurement <id> [--log <path.jsonl>] [--list]
set -euo pipefail

MEASUREMENT=""
LOG=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --measurement) MEASUREMENT="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) printf 'measurement-trend.sh: unknown argument: %s\n' "$1" >&2
       printf 'usage: measurement-trend.sh --measurement <id> [--log <path.jsonl>] [--list]\n' >&2
       exit 64 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -n "$LOG" ] || LOG="${MEASUREMENT_TREND_LOG:-$ROOT/.kontourai/telemetry/measurements.jsonl}"

# Validated BEFORE the missing-log early return (review: an invalid id bypassed validation
# entirely when no log existed), with bash's whole-string =~ rather than line-oriented
# grep (review: an embedded newline passed grep because its first line matched).
if [ "$LIST" -eq 0 ]; then
  [ -n "$MEASUREMENT" ] || { printf 'measurement-trend.sh: --measurement <id> is required (or --list)\n' >&2; exit 64; }
  if ! [[ "$MEASUREMENT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    printf 'measurement-trend.sh: --measurement must be 1-64 chars of [A-Za-z0-9._-] starting alphanumeric\n' >&2; exit 64
  fi
fi

if [ ! -f "$LOG" ]; then
  printf 'No trend log yet at %s\n' "$LOG"
  printf 'Record a reading first:  <producer> --json | scripts/telemetry/measurement-record.sh\n'
  exit 0
fi

if [ "$LIST" -eq 1 ]; then
  node -e '
    const fs = require("node:fs");
    // Corrupt rows are COUNTED here too. Review showed --list silently discarding
    // unreadable rows ("no readings recorded", exit 0, from a wholly unreadable file)
    // and crashing on a parseable non-object row. Same rule as the main report: this
    // tool must not manufacture calm out of missing data.
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
    let corrupt = 0;
    const rows = [];
    for (const l of lines) {
      let v; try { v = JSON.parse(l); } catch { corrupt += 1; continue; }
      if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.measurement !== "string") { corrupt += 1; continue; }
      rows.push(v);
    }
    if (corrupt > 0) console.log(`WARNING: ${corrupt} unreadable row(s) not listed below.`);
    const byId = new Map();
    for (const r of rows) byId.set(r.measurement, (byId.get(r.measurement) ?? 0) + 1);
    if (byId.size === 0) { console.log("no readings recorded"); process.exit(0); }
    console.log("measurement                      readings  latest");
    for (const [id, count] of [...byId].sort()) {
      const latest = rows.filter((r) => r.measurement === id).at(-1);
      console.log(`${id.padEnd(32)} ${String(count).padStart(8)}  ${latest.recorded_at ?? "?"}`);
    }
  ' "$LOG"
  exit 0
fi



node -e '
const fs = require("node:fs");
const [logPath, measurement] = process.argv.slice(1);
const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
// Unparseable rows are REPORTED, never silently dropped. Review demonstrated the old
// behaviour: with two stable readings followed by a corrupt newest row, the report printed
// "No probe changed verdict" from the older pair and exited 0 — a truncated or interrupted
// append rendering as reassurance. Whatever else this tool does, it must not manufacture
// calm out of missing data.
const corrupt = [];
const rows = [];
lines.forEach((line, index) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    corrupt.push(index + 1);
    return;
  }
  // Same corruption definition as --list (review: the two paths disagreed): a parseable
  // scalar, array, or object without a string measurement is unkeyable, hence corrupt.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.measurement !== "string") {
    corrupt.push(index + 1);
    return;
  }
  if (parsed.measurement === measurement) rows.push(parsed);
});
if (corrupt.length > 0) {
  console.log(`\n  WARNING: ${corrupt.length} unreadable row(s) in ${logPath} at line(s) ${corrupt.join(", ")}.`);
  console.log("  Those readings are NOT included below. A corrupt newest row can hide a change.");
}

if (rows.length === 0) {
  console.log(`No readings for "${measurement}".`);
  process.exit(0);
}
if (rows.length === 1) {
  console.log(`\n${measurement}: 1 reading, recorded ${rows[0].recorded_at}.`);
  console.log("A single reading has nothing to compare against — it is a value, not a trend.");
  console.log("Record another after a change to see what moved.\n");
  process.exit(0);
}

const previous = rows.at(-2);
const current = rows.at(-1);

// Compare per-probe verdicts by id. Probes that appear or disappear are reported as such
// rather than silently ignored: a probe removed from the set is a coverage change, and
// treating it as "nothing to report" is how a shrinking corpus reads as a stable one.
const index = (r) => {
  // Defensive at READ time as well as write time: rows recorded before the writer-side
  // shape check exists are still in the log, and a non-array here used to surface as
  // `.map is not a function` — an internal crash where a diagnosis belonged.
  if (r.probes !== undefined && !Array.isArray(r.probes)) {
    console.log(`  WARNING: reading at ${r.recorded_at ?? "unknown time"} has a non-array "probes"; treated as empty.`);
    return new Map();
  }
  const probes = r.probes ?? [];
  const map = new Map(probes.map((p) => [p.id, p]));
  // Legacy rows predate the writer-side duplicate check; a collapsed duplicate is corpus
  // shrinkage and must be said, not absorbed.
  if (map.size < probes.length) {
    console.log(`  WARNING: reading at ${r.recorded_at ?? "unknown time"} has duplicate probe ids; later entries win.`);
  }
  return map;
};
const before = index(previous);
const after = index(current);
const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

const changed = [];
const added = [];
const removed = [];
for (const id of ids) {
  const b = before.get(id);
  const a = after.get(id);
  if (!b) { added.push({ id, verdict: a.verdict }); continue; }
  if (!a) { removed.push({ id, verdict: b.verdict }); continue; }
  if (b.verdict !== a.verdict) changed.push({ id, from: b.verdict, to: a.verdict, line: a.first_line });
}

console.log(`\n${measurement}`);
console.log(`  previous  ${previous.recorded_at}`);
console.log(`  current   ${current.recorded_at}`);
console.log(`  ${rows.length} readings on record\n`);

if (changed.length === 0 && added.length === 0 && removed.length === 0) {
  console.log("  No probe changed verdict.\n");
} else {
  for (const c of changed) {
    console.log(`  CHANGED  ${c.id}`);
    console.log(`           ${c.from} -> ${c.to}`);
    if (c.line) console.log(`           now: ${String(c.line).slice(0, 88)}`);
  }
  for (const a of added)   console.log(`  ADDED    ${a.id} (${a.verdict}) — new probe, no history`);
  for (const r of removed) console.log(`  REMOVED  ${r.id} (was ${r.verdict}) — coverage went away`);
  console.log("");
}
' "$LOG" "$MEASUREMENT"
