#!/usr/bin/env bash
# learning-review-decide.sh — record a human ratify/reject/defer decision against a
# learning-review-proposals.sh ledger entry, in place (#352).
#
# Never mutates kit/gate/flow config; only rewrites the matching ledger line's `decision`
# object (and `follow_on_ref`, ratify-only). Writes atomically (temp file + mv). Refuses,
# with no write, to: record a decision for an unknown proposal-id; accept more than one of
# --ratify/--reject/--defer; or accept --follow-on-ref without --ratify (AC3's
# ratify-before-follow-on ordering guard).
#
# Usage:
#   learning-review-decide.sh <ledger-path> <proposal-id> --ratify|--reject|--defer \
#     --decided-by NAME [--rationale TEXT] [--follow-on-ref REF]
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: learning-review-decide.sh <ledger-path> <proposal-id> --ratify|--reject|--defer \
         --decided-by NAME [--rationale TEXT] [--follow-on-ref REF]

Rewrites the matching ledger line's `decision` object in place (status, decided_by,
decided_at, rationale). `--follow-on-ref` is only accepted together with `--ratify`
(AC3: a follow-on work item may never be linked to an unratified proposal). Exits non-zero,
writing nothing, if: <proposal-id> is not found in <ledger-path>; more than one of
--ratify/--reject/--defer is given; or --follow-on-ref is given without --ratify.

See docs/specs/learning-review-proposals-contract.md for the full contract.
USAGE
}

command -v jq >/dev/null 2>&1 || { echo "learning-review-decide: jq is required" >&2; exit 1; }

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi

ledger_path="${1:-}"
proposal_id="${2:-}"
if [[ -z "$ledger_path" || -z "$proposal_id" ]]; then
  echo "learning-review-decide: <ledger-path> and <proposal-id> are required" >&2
  usage >&2
  exit 1
fi
shift 2 || true

status=""
decided_by=""
rationale=""
follow_on_ref=""
have_follow_on_ref=0
decision_flags=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --ratify) status="ratified"; decision_flags=$((decision_flags + 1)); shift ;;
    --reject) status="rejected"; decision_flags=$((decision_flags + 1)); shift ;;
    --defer) status="deferred"; decision_flags=$((decision_flags + 1)); shift ;;
    --decided-by) decided_by="${2:-}"; shift 2 ;;
    --rationale) rationale="${2:-}"; shift 2 ;;
    --follow-on-ref) follow_on_ref="${2:-}"; have_follow_on_ref=1; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "learning-review-decide: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$decision_flags" -ne 1 ]]; then
  echo "learning-review-decide: exactly one of --ratify/--reject/--defer is required" >&2
  exit 1
fi

if [[ -z "$decided_by" ]]; then
  echo "learning-review-decide: --decided-by NAME is required" >&2
  exit 1
fi

if [[ "$have_follow_on_ref" -eq 1 && "$status" != "ratified" ]]; then
  echo "learning-review-decide: --follow-on-ref requires --ratify (AC3: no follow-on before a recorded ratify decision)" >&2
  exit 1
fi

if [[ ! -f "$ledger_path" ]]; then
  echo "learning-review-decide: ledger not found: $ledger_path" >&2
  exit 1
fi

found="$(jq -c --arg pid "$proposal_id" 'select(.proposal_id == $pid)' "$ledger_path" 2>/dev/null | head -n1)"
if [[ -z "$found" ]]; then
  echo "learning-review-decide: proposal-id not found in ledger: $proposal_id" >&2
  exit 1
fi

now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ledger_dir="$(dirname "$ledger_path")"
tmp_ledger="$(mktemp "${ledger_dir}/.learning-review-decide.XXXXXX")" || {
  echo "learning-review-decide: failed to create temp file" >&2
  exit 1
}

if ! jq -c \
  --arg pid "$proposal_id" \
  --arg status "$status" \
  --arg decided_by "$decided_by" \
  --arg decided_at "$now_iso" \
  --arg rationale "$rationale" \
  --argjson have_rationale "$([[ -n "$rationale" ]] && echo true || echo false)" \
  --arg follow_on_ref "$follow_on_ref" \
  --argjson have_follow_on_ref "$([[ "$have_follow_on_ref" -eq 1 ]] && echo true || echo false)" \
  '
  if .proposal_id == $pid then
    .decision = {
      status: $status,
      decided_by: $decided_by,
      decided_at: $decided_at,
      rationale: (if $have_rationale then $rationale else null end)
    }
    | if $have_follow_on_ref and $status == "ratified" then .follow_on_ref = $follow_on_ref else . end
  else . end
  ' "$ledger_path" > "$tmp_ledger"; then
  echo "learning-review-decide: failed to rewrite ledger" >&2
  rm -f "$tmp_ledger"
  exit 1
fi

mv "$tmp_ledger" "$ledger_path"
echo "learning-review-decide: proposal_id=$proposal_id decision.status=$status recorded" >&2
jq -c --arg pid "$proposal_id" 'select(.proposal_id == $pid)' "$ledger_path"
