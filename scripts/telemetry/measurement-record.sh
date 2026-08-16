#!/usr/bin/env bash
# Append one measurement reading to the local trend log. #1258.
#
# LOCAL ONLY, DELIBERATELY. The obvious primitive to reuse here was transport_emit
# (scripts/telemetry/lib/transport.sh:295), which fans a record out to every configured
# channel AND curl-POSTs it to any TELEMETRY_CHANNEL_<NAME>_ENDPOINT_URL that happens to
# be set. That is right for session telemetry and wrong for this: enabling a local
# observability feature must not, as a side effect, start publishing instrument readings
# off the machine. Whether measurements should ever leave the host is a separate,
# owner-gated decision, and until it is made this writer has no network path at all.
#
# evals/integration/test_measurement_trend.sh asserts that absence by stubbing curl and
# proving it is never invoked even with an endpoint configured — because the failure mode
# is silent and outbound, and so cannot be caught by reading the output.
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
    if (typeof value.measurement !== "string" || value.measurement.trim() === "") {
      process.stderr.write("measurement-record.sh: reading must carry a non-empty \"measurement\" id\n");
      process.exit(65);
    }
    // recorded_at is stamped here rather than by the producer: the producer measures, the
    // sink dates. A producer-supplied timestamp is not refused, but it never wins.
    value.recorded_at = new Date().toISOString();
    process.stdout.write(JSON.stringify(value));
  });
')"

mkdir -p "$(dirname "$LOG")"
umask 077
# Single-line append. Same idiom, and same reasoning, as transport.sh's outbox append:
# small writes to a local file are atomic enough that a concurrent reader sees whole lines.
printf '%s\n' "$recorded" >> "$LOG"
printf 'recorded to %s\n' "$LOG"
