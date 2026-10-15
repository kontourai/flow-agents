#!/usr/bin/env bash
# Agentless gate demo for the Release Evidence kit.
#
# Drives the Flow CLI that this package depends on (node_modules/@kontourai/flow,
# so the demo moves with the package's own Flow pin) through:
#   validate-definition, kit validate, init, start, attach-evidence, evaluate
# for two trust-bundle fixtures:
#   pass: a verified release.evidence claim; evaluate --exit-code must exit 0.
#   fail: a rejected release.evidence claim; evaluate --exit-code must exit
#         non-zero AND the gate diagnostic must name the claim as rejected, so
#         a fixture that fails for an unrelated reason (malformed bundle, wrong
#         claim type) cannot pass as "failure detected".
#
# Usage: scripts/ci/release-evidence-gate-demo.sh [repo-root]
set -euo pipefail

repo_root="$(cd "${1:-$(dirname "$0")/../..}" && pwd)"
flow_cli="${repo_root}/node_modules/@kontourai/flow/dist/cli.js"
kit_dir="${repo_root}/kits/release-evidence"
definition="${kit_dir}/flows/release-evidence.flow.json"
claims="${kit_dir}/fixtures/claims"
gate="release-evidence-gate"

if [[ ! -f "${flow_cli}" ]]; then
  echo "FAIL: Flow CLI not found at ${flow_cli}; run 'pnpm install --frozen-lockfile' first" >&2
  exit 1
fi

flow() { node "${flow_cli}" "$@"; }

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
cd "${workdir}"

echo "Flow CLI $(node -p 'require(process.argv[1]).version' "${repo_root}/node_modules/@kontourai/flow/package.json")"
flow validate-definition "${definition}" --json
flow kit validate "${kit_dir}"
flow init

# pass case
flow start "${definition}" --run-id gate-pass-demo
flow attach-evidence gate-pass-demo --gate "${gate}" \
  --file "${claims}/pass-trusted-release.trust.json" --kind trust.bundle
if flow evaluate gate-pass-demo --exit-code; then
  echo "PASS: verified release.evidence claim passed the gate"
else
  echo "FAIL: gate did not pass a verified release.evidence claim" >&2
  flow status gate-pass-demo --format summary >&2 || true
  exit 1
fi

# fail case
flow start "${definition}" --run-id gate-fail-demo
flow attach-evidence gate-fail-demo --gate "${gate}" \
  --file "${claims}/fail-rejected-release.trust.json" --kind trust.bundle
if flow evaluate gate-fail-demo --exit-code; then
  echo "FAIL: gate passed a rejected release.evidence claim (false negative)" >&2
  exit 1
fi
reasons="$(flow status gate-fail-demo --format json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const g=(r.gate_summaries||[]).find(x=>x.gate_id===process.argv[1]);console.log(((g&&g.diagnostics&&g.diagnostics.claim_evaluation)||[]).map(c=>c.reason).join(","))})' "${gate}")"
if [[ ",${reasons}," == *",rejected,"* ]]; then
  echo "PASS: gate refused the rejected claim (claim_evaluation reasons: ${reasons})"
else
  echo "FAIL: gate did not pass, but not because the claim was rejected (claim_evaluation reasons: '${reasons}')" >&2
  flow status gate-fail-demo --format summary >&2 || true
  exit 1
fi
