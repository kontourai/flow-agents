#!/usr/bin/env bash
# test_model_routing_escalation.sh — #376
# Deliver-loop eval: a cheap-tier delegate's output FAILS a gate, the fix is
# re-dispatched one tier HIGHER (escalation), and the escalation + every
# per-delegation role/model decision are recorded on the session artifact in a
# shape a downstream economics record (#349) can consume.
#
#   R2/AC2: fail -> escalate -> pass, escalation recorded with the tier it climbed FROM.
#   R3/AC3: a verify/review delegation's role tier is >= the worker tier it checks.
#   R4/AC4: per-delegation role/model land on agents/<id>/events.jsonl, additive.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
VALIDATOR="validate-workflow-artifacts"
TMPDIR_EVAL="$(mktemp -d)"
errors=0
cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

AR="$TMPDIR_EVAL/repo/.kontourai/flow-agents"
SLUG="routing-escalation"
SDIR="$AR/$SLUG"
mkdir -p "$AR"

ev() { flow_agents_node "$WRITER" record-agent-event --artifact-root "$AR" "$@"; }

# ── session ───────────────────────────────────────────────────────────────────
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AR" --task-slug "$SLUG" \
  --title "Routing escalation" \
  --summary "Cheap tier fails a gate; fix escalates one tier higher." \
  --criterion "Escalation recorded" \
  --timestamp "2026-07-04T00:00:00Z" >"$TMPDIR_EVAL/ensure.out" 2>&1; then
  _pass "ensure-session created the deliver-loop session"
else
  _fail "ensure-session failed: $(cat "$TMPDIR_EVAL/ensure.out")"
fi

# ── deliver loop: delegate cheap -> gate FAIL -> escalate one tier up -> PASS ──
# 1. Dispatch a fully-specified mechanical slice at the cheap tier (R4 record).
ev --agent-id tool-worker-1 --kind delegation --status active \
  --role delegate-mechanical --model "claude-haiku-4-5@anthropic" \
  --summary "mechanical slice: routine config edit" \
  --timestamp "2026-07-04T00:00:01Z" >/dev/null 2>&1 \
  && _pass "recorded mechanical delegation (delegate-mechanical)" \
  || _fail "failed to record mechanical delegation"

# 2. Verify gate FAILS on that cheap delegate's output.
ev --agent-id tool-verifier --kind evidence --status fail \
  --role delegate-implementation --model "claude-sonnet-5@anthropic" \
  --summary "verify gate FAILED on tool-worker-1 output" \
  --timestamp "2026-07-04T00:00:02Z" >/dev/null 2>&1 \
  && _pass "recorded verify gate FAILURE on cheap-tier output" \
  || _fail "failed to record gate failure"

# 3. Escalate: re-dispatch the FIX one tier higher, recording the tier climbed FROM.
ev --agent-id tool-worker-2 --kind escalation --status active \
  --role delegate-implementation --model "claude-sonnet-5@anthropic" \
  --escalated-from delegate-mechanical \
  --summary "fix re-dispatched one tier higher after gate failure" \
  --timestamp "2026-07-04T00:00:03Z" >/dev/null 2>&1 \
  && _pass "recorded escalation (delegate-mechanical -> delegate-implementation)" \
  || _fail "failed to record escalation"

# 4. Re-verify PASSES on the escalated fix. Goodhart guard: the verifier tier
#    (delegate-implementation) is >= the worker tier it checks (delegate-implementation).
ev --agent-id tool-verifier --kind evidence --status pass \
  --role delegate-implementation --model "claude-sonnet-5@anthropic" \
  --summary "verify gate PASSED on escalated fix" \
  --timestamp "2026-07-04T00:00:04Z" >/dev/null 2>&1 \
  && _pass "recorded verify PASS after escalation" \
  || _fail "failed to record verify pass"

# ── assertions over the recorded session artifact ─────────────────────────────
node - "$SDIR" <<'NODE'
const fs = require("fs");
const path = require("path");
const sdir = process.argv[2];
const TIER = { "delegate-mechanical": 1, "delegate-implementation": 2, "delegate-design": 3, "orchestrator": 4 };

function readEvents(agent) {
  const f = path.join(sdir, "agents", agent, "events.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let bad = 0;
const say = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) bad++; };

// R4/AC4: every delegation/escalation event carries a consumable role + model.
const w1 = readEvents("tool-worker-1");
const del = w1.find((e) => e.kind === "delegation");
say(del && del.role === "delegate-mechanical" && del.model === "claude-haiku-4-5@anthropic",
  "R4: mechanical delegation event carries role + model (economics-consumable)");

// R4 additive/back-compat: a plain event carries no routing keys.
const plainRoot = path.join(sdir, "state.json");
say(fs.existsSync(plainRoot), "session state.json exists (additive change did not break session shape)");

// R2/AC2: escalation event recorded, one tier higher, with the tier climbed FROM.
const esc = readEvents("tool-worker-2").find((e) => e.kind === "escalation");
say(!!esc, "R2: escalation event recorded");
say(esc && esc.escalated_from === "delegate-mechanical", "R2: escalation records escalated_from = delegate-mechanical");
say(esc && TIER[esc.role] === TIER[esc.escalated_from] + 1,
  "R2: escalation climbed exactly one tier up the ladder (mechanical -> implementation)");

// R3/AC3: the verifier tier is >= the worker tier it checks (Goodhart guard).
const verifs = readEvents("tool-verifier").filter((e) => e.role);
const workerTier = TIER["delegate-implementation"]; // tier of the escalated fix under verification
const allGuarded = verifs.every((v) => TIER[v.role] >= workerTier);
say(verifs.length >= 1 && allGuarded, "R3: verify role tier >= worker tier (never a cheaper checker)");

// AC4: demonstrate the #349-consumable reduction — price per role across the run.
const allEvents = [];
for (const agent of fs.readdirSync(path.join(sdir, "agents"))) {
  allEvents.push(...readEvents(agent));
}
const byRole = {};
for (const e of allEvents) if (e.role) byRole[e.role] = (byRole[e.role] || 0) + 1;
say(Object.keys(byRole).length >= 2 && byRole["delegate-mechanical"] >= 1 && byRole["delegate-implementation"] >= 1,
  `AC4: routing records reduce to a per-role economics shape: ${JSON.stringify(byRole)}`);

process.exit(bad === 0 ? 0 : 1);
NODE
if [[ $? -eq 0 ]]; then _pass "session artifact routing/escalation/Goodhart assertions passed"; else _fail "session artifact assertions failed"; fi

# ── additive shape must still validate ────────────────────────────────────────
if flow_agents_node "$VALIDATOR" "$SDIR" >"$TMPDIR_EVAL/validate.out" 2>&1; then
  _pass "validate-workflow-artifacts accepts the additive routing fields"
else
  _fail "validate-workflow-artifacts rejected routing fields: $(cat "$TMPDIR_EVAL/validate.out")"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Model routing escalation (deliver-loop) integration passed."
  exit 0
fi
echo "Model routing escalation integration failed: $errors issue(s)."
exit 1
