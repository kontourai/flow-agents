#!/usr/bin/env bash
# install-identity.sh — the Flow Agents producer-identity resolver (#1180, #970).
#
# SOURCED, never executed. Provides install_identity() and its two helpers to both
# scripts/telemetry/telemetry.sh (stamps every telemetry base_event) and
# scripts/telemetry/economics-record.sh (stamps the durable per-run economics record).
# Factored out of telemetry.sh so the two halves resolve the SAME tuple from ONE
# implementation — consume, never fork (#970 reconciliation, 2026-08-04).
#
# Contract: the sourcing script must have TELEMETRY_DIR set to the telemetry script
# directory (both callers do). Requires jq and, for the git fallback, git. Every path
# is fail-open: resolution hiccups degrade to the labeled unknown tuple, never an error.
# install_identity_is_flow_agents_package — true iff the given package.json declares THIS package.
#
# Load-bearing, not a formality: the claude-code project bundle lays scripts/ into the CONSUMER's
# own repository (build-universal-bundles.ts resolves hooks against $CLAUDE_PROJECT_DIR), so an
# identity resolved without this check would report the consumer project's version and commit as
# Flow Agents' producer identity — a fabricated join key, precisely the failure #1180 exists to
# prevent. A foreign or unreadable package.json means "not our install," never a guess.
install_identity_is_flow_agents_package() {
  local manifest="$1" pkg_name
  [[ -f "$manifest" ]] || return 1
  pkg_name=$(jq -r '.name // ""' "$manifest" 2>/dev/null) || return 1
  [[ "$pkg_name" == "@kontourai/flow-agents" ]]
}

# install_identity_package_root — this package's root as seen from the telemetry script's own
# directory. Echoes the root, or nothing when it cannot be established.
#
# TWO FIXED OFFSETS, NO SEARCH. telemetry.sh ships in two byte-identical copies at two structural
# depths and nowhere else: scripts/telemetry/ (root is ../..) and the context/scripts/telemetry/
# mirror (root is ../../..). Because validate:source enforces the copies byte-identical, no per-copy
# constant can exist — but the SET of legitimate offsets is closed and tiny, so both are simply
# checked. First offset whose package.json declares this package wins; neither → unknown.
#
# WHY NOT A WALK UP THE TREE (this replaced one, and the replacement is the point): a bounded climb
# makes ANCESTOR ADOPTION reachable. Install a fresh dist/claude-code bundle into a scratch
# directory nested under a Flow Agents checkout — an entirely ordinary thing to do — and the climb
# passes the bundle's own stampless root and the scratch directory, reaches the surrounding
# checkout, and reports THAT checkout's version and content fingerprint as the bundle's identity.
# A confidently wrong tuple attributed to a different install copy is strictly worse than no
# identity at all: the original depth bug only ever failed to "unknown", which is honest. With
# fixed offsets the bundle's ../.. is its own root and ../../.. is the scratch directory; the
# surrounding checkout sits deeper than either and is structurally unreachable.
#
# The bare {"type":"commonjs"} module-type markers this repo ships at scripts/package.json and
# context/scripts/package.json are irrelevant here: they sit one level below a telemetry directory's
# parent, and a depth-1 offset is never a candidate.
install_identity_package_root() {
  local dir="$1" candidate
  for candidate in "${dir}/../.." "${dir}/../../.."; do
    if install_identity_is_flow_agents_package "${candidate}/package.json"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 0
}

# install_identity — the producer-identity tuple for the Flow Agents install emitting this event
# (#1180). Echoes {package_version, content_fingerprint, source}.
#
# WHY A TUPLE: a semver string is a lying join key. A tarball packed from post-release main
# installs as "5.7.0" while containing 5.8.0's code, so per-release effectiveness analysis keyed on
# version alone attributes the new behavior to the old release. `content_fingerprint` says what the
# artifact actually CONTAINS; `source` says how the identity was resolved, so a consumer can always
# tell a shipped stamp from a dev-checkout derivation from nothing at all.
#
# WHY A TOP-LEVEL SIBLING and never a member of `run_correlation`: the run correlation envelope is
# contractually CLOSED in v1 — schemas/run-correlation-envelope.schema.json is
# additionalProperties:false at every level, and producer identity is not one of its identity
# slots. The join (correlation_id x install_identity) is available on every record either way.
# See context/contracts/run-correlation-contract.md.
#
# Resolution order, first hit wins:
#   1. "stamp"   build/generated/install-identity.json shipped inside the package
#                (src/tools/generate-install-identity.ts, written by the last step of
#                `npm run build`). The fingerprint is computed at build time, so event-time cost is
#                one file read.
#   2. "git"     no stamp, but the package root is a Flow Agents source checkout and git resolves a
#                HEAD. Fingerprint is "git:<sha>".
#   3. "unknown" every field the literal string "unknown". Labeled, never guessed.
#
# FLOW_AGENTS_INSTALL_IDENTITY_ROOT overrides the package root (fixture isolation for evals),
# mirroring the FLOW_AGENTS_CAPABILITY_DECL_FILE override economics-record.sh already exposes.
install_identity() {
  local pkg_root stamp_file version fingerprint identity_source git_sha
  pkg_root="${FLOW_AGENTS_INSTALL_IDENTITY_ROOT:-$(install_identity_package_root "$TELEMETRY_DIR")}"
  version=""; fingerprint=""; identity_source=""
  [[ -n "$pkg_root" ]] || { jq -nc '{package_version:"unknown",content_fingerprint:"unknown",source:"unknown"}'; return 0; }
  stamp_file="${pkg_root}/build/generated/install-identity.json"
  if [[ -f "$stamp_file" ]]; then
    version=$(jq -r '.package_version // ""' "$stamp_file" 2>/dev/null) || version=""
    fingerprint=$(jq -r '.content_fingerprint // ""' "$stamp_file" 2>/dev/null) || fingerprint=""
    if [[ -n "$version" && -n "$fingerprint" ]]; then
      identity_source="stamp"
    else
      # A present-but-unreadable/partial stamp is NOT a half-truth to publish: drop it entirely and
      # fall through to the labeled fallbacks below.
      version=""; fingerprint=""
    fi
  fi
  if [[ -z "$identity_source" && -f "${pkg_root}/package.json" ]]; then
    if install_identity_is_flow_agents_package "${pkg_root}/package.json"; then
      git_sha=$(git -C "$pkg_root" rev-parse HEAD 2>/dev/null) || git_sha=""
      if [[ "$git_sha" =~ ^[0-9a-f]{40,64}$ ]]; then
        fingerprint="git:${git_sha}"
        version=$(jq -r '.version // ""' "${pkg_root}/package.json" 2>/dev/null) || version=""
        [[ -n "$version" ]] || version="unknown"
        identity_source="git"
      fi
    fi
  fi
  [[ -n "$identity_source" ]] || { version="unknown"; fingerprint="unknown"; identity_source="unknown"; }
  jq -nc --arg v "$version" --arg f "$fingerprint" --arg s "$identity_source" \
    '{package_version: $v, content_fingerprint: $f, source: $s}'
}
