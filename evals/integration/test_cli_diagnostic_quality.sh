#!/usr/bin/env bash
# #1257: a verb that refuses must explain the refusal.
#
# Before this contract existed, `process.exit(await run())` had no handler, so any throw
# reached Node's default reporter and printed internal frames. Six of eight probes — every
# workflow verb, the ones an agent touches on every stage transition — answered a mistyped
# session dir with `node:fs:1771` and a stack. The operator learns nothing and retries,
# which is the retry-discovery burn this repo keeps paying for.
#
# The assertion is PER PROBE, not a pass count. A count would fail whoever gates next
# without saying which behaviour regressed, and the cheapest way to green it would be to
# lower the number. Naming each probe means a regression names itself.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEASURE="$ROOT/evals/measure/diagnostic-quality.sh"
errors=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; errors=$((errors + 1)); }

printf '\ntest_cli_diagnostic_quality\n'

if [ ! -f "$ROOT/build/src/cli.js" ]; then
  printf '  SKIP  no build present; run npm run build first\n'
  exit 0
fi

report="$(bash "$MEASURE" --json 2>&1)" || {
  printf '  FAIL  measurement did not run\n%s\n' "$report"
  exit 1
}

verdict_for() {
  printf '%s' "$report" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const r = JSON.parse(s);
      const p = r.probes.find(p => p.id === process.argv[1]);
      process.stdout.write(p ? p.verdict : "MISSING");
    });
  ' "$1"
}

first_line_for() {
  printf '%s' "$report" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const r = JSON.parse(s);
      const p = r.probes.find(p => p.id === process.argv[1]);
      process.stdout.write(p ? p.first_line : "");
    });
  ' "$1"
}

# 1. Every probe answers with an authored diagnostic — named individually.
for id in evidence-missing-dir evidence-no-state evidence-bad-state status-missing-dir \
          critique-missing-dir start-unknown-flow uninstall-no-runtime kit-unknown-verb; do
  v="$(verdict_for "$id")"
  case "$v" in
    CLEAN)   pass "$id answers with an authored diagnostic" ;;
    STACK)   fail "$id leaked internal stack frames" ;;
    RAW)     fail "$id answered with an unauthored runtime error (caught, but not explained)" ;;
    MISSING) fail "$id is not present in the measurement — probe list drifted" ;;
    *)       fail "$id returned an unrecognised verdict: $v" ;;
  esac
done

# 2. The #1257 contract specifically: name WHICH component is missing, and where.
#    A generic "not found" would satisfy the verdict above while still leaving the operator
#    to guess which of the five path components is the problem.
line="$(first_line_for evidence-missing-dir)"
case "$line" in
  *"session directory not found at "*) pass "missing session dir names the component and the path" ;;
  *) fail "missing session dir did not name component + path, got: $line" ;;
esac

line="$(first_line_for evidence-no-state)"
case "$line" in
  *"workflow state not found at "*) pass "missing state.json names the component and the path" ;;
  *) fail "missing state.json did not name component + path, got: $line" ;;
esac

# 3. A corrupt state file names the file, not just the parser's position.
line="$(first_line_for evidence-bad-state)"
case "$line" in
  *"workflow state is not valid JSON"*) pass "corrupt state file names the file it could not read" ;;
  *) fail "corrupt state file did not name the file, got: $line" ;;
esac

# 4. No probe may exit 0. Explaining a refusal must not turn it into an acceptance —
#    the whole contract is worthless if a clearer message came with a silent success.
zero_exits="$(printf '%s' "$report" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const r = JSON.parse(s);
    process.stdout.write(String(r.probes.filter(p => p.exit === 0).length));
  });
')"
if [ "$zero_exits" = "0" ]; then
  pass "every refusal still exits non-zero"
else
  fail "$zero_exits probe(s) exited 0 — a refusal became an acceptance"
fi

printf '\n  %s failure(s)\n\n' "$errors"
[ "$errors" -eq 0 ] || exit 1
exit 0
