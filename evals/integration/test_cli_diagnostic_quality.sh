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
    VAGUE)   fail "$id avoided looking like a crash but named no path, flag or usage" ;;
    MISSING) fail "$id is not present in the measurement — probe list drifted" ;;
    *)       fail "$id returned an unrecognised verdict: $v" ;;
  esac
done

# 2. The #1257 contract specifically: name WHICH component is missing, and WHERE.
#    Review finding (HIGH): the first version of these used a trailing wildcard, which an
#    empty suffix satisfies — `session directory not found at ` with no path scored a pass.
#    The path is the actionable half, so it is asserted as a non-empty absolute path.
assert_names_component_and_path() {
  local id="$1" phrase="$2" line
  line="$(first_line_for "$id")"
  case "$line" in
    *"$phrase"*) ;;
    *) fail "$id did not say '$phrase', got: $line"; return ;;
  esac
  # everything after the phrase must be a non-empty absolute path
  local suffix="${line#*"$phrase"}"
  case "$suffix" in
    /?*) pass "$id names the component and a non-empty absolute path" ;;
    "")  fail "$id named the component but the path was EMPTY: $line" ;;
    *)   fail "$id path is not absolute: $line" ;;
  esac
}
assert_names_component_and_path evidence-missing-dir "session directory not found at "
assert_names_component_and_path evidence-no-state    "workflow state not found at "

# 3. A corrupt state file names the file it could not read, not just the parser's position.
#    Same finding: asserting the phrase alone allowed a message with no filename at all.
line="$(first_line_for evidence-bad-state)"
case "$line" in
  *"workflow state is not valid JSON"*/*)
    pass "corrupt state file names the file it could not read" ;;
  *"workflow state is not valid JSON"*)
    fail "corrupt state file said 'not valid JSON' but named no file: $line" ;;
  *)
    fail "corrupt state file did not report a JSON problem, got: $line" ;;
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

# 5. The handler's own contract, which the verdicts above do not cover:
#    a caught throw exits 70, and the stack is available on demand but withheld by default.
#    Review finding: neither was asserted, so the documented FLOW_AGENTS_DEBUG promise and
#    the chosen exit code were both free to drift.
probe_root="$(mktemp -d)"
trap 'rm -rf "$probe_root"' EXIT
mkdir -p "$probe_root/.kontourai/flow-agents"
(cd "$probe_root" && git init -q . 2>/dev/null || true)

throw_probe() {
  (cd "$probe_root" && node "$ROOT/build/src/cli.js" workflow status \
     --session-dir .kontourai/flow-agents/absent) 2>&1
}
throw_probe_code() {
  (cd "$probe_root" && node "$ROOT/build/src/cli.js" workflow status \
     --session-dir .kontourai/flow-agents/absent >/dev/null 2>&1; echo $?)
}

code="$(throw_probe_code)"
if [ "$code" = "70" ]; then
  pass "a caught throw exits 70"
else
  fail "a caught throw exited $code, expected 70"
fi

plain="$(throw_probe)"
if printf '%s\n' "$plain" | grep -qE '^[[:space:]]+at '; then
  fail "default output leaked stack frames"
else
  pass "default output withholds the stack"
fi
if printf '%s\n' "$plain" | grep -q 'FLOW_AGENTS_DEBUG=1'; then
  pass "default output tells the operator how to get the stack"
else
  fail "default output does not mention FLOW_AGENTS_DEBUG=1"
fi

debug="$(cd "$probe_root" && FLOW_AGENTS_DEBUG=1 node "$ROOT/build/src/cli.js" workflow status \
          --session-dir .kontourai/flow-agents/absent 2>&1)"
if printf '%s\n' "$debug" | grep -qE '^[[:space:]]+at '; then
  pass "FLOW_AGENTS_DEBUG=1 actually produces the stack"
else
  fail "FLOW_AGENTS_DEBUG=1 promised a stack and produced none"
fi

printf '\n  %s failure(s)\n\n' "$errors"
[ "$errors" -eq 0 ] || exit 1
exit 0
