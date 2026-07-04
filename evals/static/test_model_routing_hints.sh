#!/usr/bin/env bash
# test_model_routing_hints.sh — #376
# Asserts that every delegating Builder Kit skill carries a per-step model-role
# hint pointing at the execution contract (AC1/R1), that the execution contract
# documents the escalate-on-gate-failure ladder (R2) and the Goodhart guard
# (R3, review/verify tier >= worker tier), and that review/verify skill hints
# encode that guard.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

SKILLS="kits/builder/skills"
CONTRACT="context/contracts/execution-contract.md"
POINTER="context/contracts/execution-contract.md"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

require_contains() {
  local file="$1" pattern="$2" label="$3"
  grep -Fq -- "$pattern" "$file" || fail "$label ($file)"
  pass "$label"
}

skill_has_routing_hint() {
  # A delegating skill must have a Model Routing section that points at the
  # execution contract's routing section — the single consumption instruction.
  local skill="$1"
  local file="$SKILLS/$skill/SKILL.md"
  [[ -f "$file" ]] || fail "$skill SKILL.md missing"
  grep -q "^## Model Routing" "$file" || fail "$skill has no '## Model Routing' section"
  grep -Fq "$POINTER" "$file" || fail "$skill routing hint does not point at the execution contract"
  pass "$skill has a Model Routing hint pointing at the execution contract"
}

skill_names_role() {
  local skill="$1" role="$2"
  local file="$SKILLS/$skill/SKILL.md"
  grep -Fq "$role" "$file" || fail "$skill does not name role '$role'"
  pass "$skill names role '$role'"
}

# ── R1/AC1: the delegating Builder Kit skills and the role each must name ──────
# Design tier: shaping / probing / planning need design latitude.
for s in builder-shape design-probe idea-to-backlog plan-work; do
  skill_has_routing_hint "$s"
  skill_names_role "$s" "delegate-design"
done

# Mechanical tier: board selection / sync / scan bookkeeping.
skill_has_routing_hint "pull-work"
skill_names_role "pull-work" "delegate-mechanical"

# Implementation tier: worker slices.
skill_has_routing_hint "execute-plan"
skill_names_role "execute-plan" "delegate-implementation"

# Review / verify: default implementation, subject to the Goodhart guard (R3).
for s in review-work verify-work; do
  skill_has_routing_hint "$s"
  skill_names_role "$s" "delegate-implementation"
done

# Multi-delegate orchestrators carry a role table covering all three tiers.
for s in deliver fix-bug tdd-workflow; do
  skill_has_routing_hint "$s"
  skill_names_role "$s" "delegate-mechanical"
  skill_names_role "$s" "delegate-implementation"
  skill_names_role "$s" "delegate-design"
done

# ── Drift guard: any builder skill that names a tool-* delegate must be a
#    registered delegating skill above (i.e., must carry a Model Routing hint).
DELEGATING="builder-shape design-probe idea-to-backlog plan-work pull-work execute-plan review-work verify-work deliver fix-bug tdd-workflow"
for file in "$SKILLS"/*/SKILL.md; do
  skill="$(basename "$(dirname "$file")")"
  if grep -qE "tool-(worker|planner|code-reviewer|security-reviewer|verifier|playwright)" "$file"; then
    case " $DELEGATING " in
      *" $skill "*) : ;;
      *) fail "skill '$skill' names a tool-* delegate but has no registered Model Routing hint (register it in test_model_routing_hints.sh and add the hint)" ;;
    esac
  fi
done
pass "every tool-* delegating builder skill is registered with a Model Routing hint"

# ── R3/AC3: review + verify skill hints encode the Goodhart guard ─────────────
for s in review-work verify-work; do
  file="$SKILLS/$s/SKILL.md"
  grep -Fq "Goodhart guard" "$file" || fail "$s hint does not name the Goodhart guard"
  grep -Fq "never" "$file" || fail "$s hint does not state the never-downgrade rule"
  grep -Fiq "below" "$file" || fail "$s hint does not say review/verify never resolves below the checked work"
  pass "$s hint encodes the Goodhart guard (never below the checked-work tier)"
done

# ── R2/AC2 + R3/AC3: the execution contract documents ladder + guard + record ─
require_contains "$CONTRACT" "delegate-mechanical  <  delegate-implementation  <  delegate-design" "contract defines the tier ladder ordering"
require_contains "$CONTRACT" "Escalation on gate failure" "contract documents the escalation ladder"
require_contains "$CONTRACT" "one tier higher" "contract escalates the fix one tier higher on gate failure"
require_contains "$CONTRACT" "Goodhart guard" "contract documents the Goodhart guard"
require_contains "$CONTRACT" "greater than or equal to" "contract states review/verify tier >= checked-work tier"
# R4: contract names the additive per-delegation recording shape (#349 consumable).
require_contains "$CONTRACT" "Routing decisions in the run artifact" "contract documents routing-in-artifact recording"
require_contains "$CONTRACT" "--escalated-from" "contract records escalations with --escalated-from"
require_contains "$CONTRACT" "flow-agents#349" "contract ties routing records to the #349 economics record"

echo "Model routing hint + ladder + Goodhart guard static checks passed."
