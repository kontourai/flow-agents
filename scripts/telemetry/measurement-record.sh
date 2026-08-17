#!/usr/bin/env bash
# Append one measurement reading to the local trend log. #1258.
#
# LOCAL BY CONSTRUCTION. The obvious primitive to reuse here was transport_emit
# (scripts/telemetry/lib/transport.sh:295), which fans a record out to every configured
# channel AND curl-POSTs it to any TELEMETRY_CHANNEL_<NAME>_ENDPOINT_URL that happens to
# be set. That is right for session telemetry and wrong for this: enabling a local
# observability feature must not, as a side effect, start publishing instrument readings
# off the machine. Whether measurements should ever leave the host is a separate,
# owner-gated decision, and until it is made this script sources no transport library and
# makes no outbound call of its own.
#
# WHAT THAT DOES AND DOES NOT GUARANTEE. An earlier version of this comment claimed "no
# network path at all". Independent review refuted it: inherited NODE_OPTIONS can preload
# arbitrary JavaScript into the `node` below, and BASH_ENV can inject arbitrary shell into
# any non-interactive bash — neither of which a stubbed `curl` can observe. That is true of
# every script in this repo and is not a property this one can promise. Both variables are
# therefore scrubbed below, which closes the cheap vector; a hostile PATH or a wrapped
# interpreter remains outside what this script can defend, and the test asserts the scrubbing
# rather than the unachievable absence.
#
# Usage:
#   <producer> --json | measurement-record.sh
#   measurement-record.sh --file reading.json
#   measurement-record.sh --file reading.json --log /custom/path.jsonl
set -euo pipefail

LOG=""
FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="$2"; shift 2 ;;
    --log)  LOG="$2"; shift 2 ;;
    *) printf 'measurement-record.sh: unknown argument: %s\n' "$1" >&2
       printf 'usage: measurement-record.sh [--file <reading.json>] [--log <path.jsonl>]\n' >&2
       exit 64 ;;
  esac
done

# Scrub the two inherited-environment preload vectors before any interpreter runs. This
# does not make the script hermetic (see header) — it removes the two that cost nothing.
unset NODE_OPTIONS BASH_ENV

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -n "$LOG" ] || LOG="${MEASUREMENT_TREND_LOG:-$ROOT/.kontourai/telemetry/measurements.jsonl}"

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || { printf 'measurement-record.sh: no such file: %s\n' "$FILE" >&2; exit 66; }
  payload="$(cat "$FILE")"
else
  payload="$(cat)"
fi

if [ -z "${payload//[[:space:]]/}" ]; then
  printf 'measurement-record.sh: empty reading on stdin; nothing recorded\n' >&2
  exit 65
fi

# Reject anything that is not a JSON object carrying a measurement id. A trend log whose
# rows cannot be keyed is not a trend log, and finding that out at read time means the
# readings were already lost.
recorded="$(printf '%s' "$payload" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let value;
    try {
      value = JSON.parse(s);
    } catch (error) {
      process.stderr.write(`measurement-record.sh: reading is not valid JSON: ${error.message}\n`);
      process.exit(65);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      process.stderr.write("measurement-record.sh: reading must be a JSON object\n");
      process.exit(65);
    }
    // The id is the join key AND is later passed back through an argv flag, so it is
    // constrained to what can survive that round trip. Review found a NUL-containing id
    // accepted here that --measurement could never match: a row keyed by something
    // unaddressable is a lost reading, not a recorded one.
    if (typeof value.measurement !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.measurement)) {
      process.stderr.write(
        "measurement-record.sh: \"measurement\" must be 1-64 chars of [A-Za-z0-9._-] starting alphanumeric\n"
      );
      process.exit(65);
    }
    // `probes` must be an array if present. Review found `probes:{}` accepted here and
    // then crashing the reporter with `.map is not a function` — the sink accepting a
    // shape the reader cannot process is a defect here, discovered a day later.
    if (value.probes !== undefined) {
      if (!Array.isArray(value.probes)) {
        process.stderr.write("measurement-record.sh: \"probes\" must be an array when present\n");
        process.exit(65);
      }
      const ids = [];
      for (const probe of value.probes) {
        if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
          process.stderr.write("measurement-record.sh: every probe must be a JSON object\n");
          process.exit(65);
        }
        if (typeof probe.id !== "string" || probe.id.trim() === "") {
          process.stderr.write("measurement-record.sh: every probe needs a non-empty string id\n");
          process.exit(65);
        }
        // Duplicates were silently collapsed by the Map in the reporter, quietly shrinking
        // the corpus — the exact absence-reads-as-stability failure this tool exists to
        // prevent, occurring inside the tool.
        if (ids.includes(probe.id)) {
          process.stderr.write(`measurement-record.sh: duplicate probe id "${probe.id}"\n`);
          process.exit(65);
        }
        ids.push(probe.id);
        // Verdicts are printed verbatim by the change report. Review supplied "80%"/"70%"
        // and got "80% -> 70%" out of a report whose whole point is not to emit a score.
        if (probe.verdict !== undefined && !/^[A-Z][A-Z_-]{0,31}$/.test(String(probe.verdict))) {
          process.stderr.write(
            `measurement-record.sh: probe "${probe.id}" verdict must be an uppercase token, got: ${String(probe.verdict)}\n`
          );
          process.exit(65);
        }
      }
    }
    // recorded_at is stamped here rather than by the producer: the producer measures, the
    // sink dates. A producer-supplied timestamp is not refused, but it never wins.
    value.recorded_at = new Date().toISOString();
    process.stdout.write(JSON.stringify(value));
  });
')"

umask 077
mkdir -p "$(dirname "$LOG")"
# umask only governs files this script CREATES. Review noted a pre-existing 0644 log stays
# 0644, so an operator who once created it loosely keeps leaking every future reading.
if [ -e "$LOG" ]; then
  # `stat` is not portable and the two spellings are not merely different, they are
  # DANGEROUSLY different: BSD `-f` selects a format string, GNU `-f` reports FILESYSTEM
  # status and exits 0 having printed something that is not a mode. Chaining them with ||
  # therefore succeeded on Linux with garbage, which this guard read as "not 600" and
  # refused every append — green on macOS, broken in CI. So each result is validated as
  # octal digits before it is believed, rather than trusting the exit code.
  mode=""
  for candidate in "$(stat -c '%a' "$LOG" 2>/dev/null || true)" "$(stat -f '%Lp' "$LOG" 2>/dev/null || true)"; do
    case "$candidate" in
      ""|*[!0-7]*) : ;;
      *) mode="$candidate"; break ;;
    esac
  done
  case "$mode" in
    ""|600|400) : ;;
    *) printf 'measurement-record.sh: refusing to append: %s is mode %s, expected 600\n' "$LOG" "$mode" >&2
       printf 'measurement-record.sh: readings retain producer output (paths, command text). Run: chmod 600 %s\n' "$LOG" >&2
       exit 77 ;;
  esac
fi
# Single-line append. Same idiom, and same reasoning, as transport.sh's outbox append:
# small writes to a local file are atomic enough that a concurrent reader sees whole lines.
printf '%s\n' "$recorded" >> "$LOG"
printf 'recorded to %s\n' "$LOG"
