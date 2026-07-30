#!/usr/bin/env bash
# kit-identity.sh — resolves the INSTALLED Flow Agents Kit's own identity: package
# version + git lineage (sha/ref/dirty), from THIS SCRIPT'S OWN on-disk location
# (never cwd, process ancestry, or a timestamp — flow-agents #970's explicit
# contract). Sourced by telemetry.sh (stamped on every event as `.kit`) and
# economics-record.sh (stamped as a sibling of `pricing_version`) so a single
# run's events and its economics record carry byte-identical values.
#
# DESIGN CHOICE (#970): version + git sha/ref/dirty, NOT a content digest of the
# installed tree. #970's design note prefers a digest of the installed runtime
# as the strongest identity (a git sha identifies SOURCE, not the built
# artifact — two installs from one sha with differing dependency resolution can
# behave differently). Corrected survey (an earlier draft of this comment
# wrongly called the Codex manifest "differently-shaped" -- it is not):
# `.flow-agents/runtime-assets.json` (OpenCode global-asset installs,
# src/cli/init.ts installOpencodeGlobalAssets) and
# `.flow-agents/codex-install-manifest.json` (scripts/install-codex-home.sh)
# are BOTH written by the SAME scripts/install-owned-files.js writer and share
# the SAME per-file `{schema_version, files:[{path, sha256}]}` shape under
# different filenames -- 2 of the 3 install paths already have a
# digest-usable manifest today. Only the plain-rsync install.sh path (used for
# a source clone / npm tarball install) has no manifest at all, so a
# digest-first design would still need a version+sha+dirty fallback for that
# path regardless. Building the cross-install digest plumbing (choosing which
# manifest per runtime, handling the no-manifest install.sh case, keeping it
# in sync as new runtimes/manifests are added) is disproportionate to this
# slice. Left as an explicit follow-up. version+sha+dirty already answers "did
# this exact release, from this exact commit, with no local edits, produce
# this telemetry" — the "two installs, same sha, different installed content"
# case a digest would additionally catch (e.g. divergent `npm ci` resolution)
# is a disclosed, accepted gap of this implementation.
#
# RESOLUTION RULES (never guess, never omit silently — #970 AC4):
#   - kit root: walk up from this lib file's own resolved directory looking for
#     the SAME {package.json + packaging/} signature src/tools/common.ts
#     findRoot() already uses as the canonical "is this the Kit's own root"
#     test (never a bare package.json alone, which risks matching an ambient
#     PARENT project the kit happens to be installed inside). Bounded to 10
#     levels to avoid a runaway walk on a pathological filesystem.
#   - version: read from `<kit_root>/package.json`'s `.version`. This is the
#     identity's mandatory anchor — `.kit.resolution` is `"resolved"` iff a
#     version resolves, else `"incomplete"` with an explicit `.reason`.
#   - git lineage (sha/ref/dirty) is independently best-effort: only attempted
#     when `<kit_root>/.git` exists as a DIRECT entry of kit_root (a real git
#     checkout or worktree) — NEVER via `git -C <kit_root>`'s normal upward
#     `.git` search, which would silently attribute an ambient PARENT repo
#     (e.g. the consuming project the kit was installed into) as the kit's own
#     lineage. A packaged install (npm tarball, no `.git`) yields explicit
#     `git_sha`/`git_ref`/`dirty: null` with `.reason` set — `.resolution` can
#     still be `"resolved"` on version alone (a real, if partial, identity).
#     Each of sha/ref/dirty is gated on its OWN command's REAL EXIT STATUS,
#     never on stdout emptiness alone: `git rev-parse HEAD` on an UNBORN HEAD
#     (a real `.git`, zero commits) exits 128 but still prints the literal
#     string `HEAD` to stdout (standard git behavior for an unresolvable ref)
#     — an emptiness-only check would accept that as a fabricated, plausible-
#     looking sha. `git_sha` is additionally shape-validated (`^[0-9a-f]{40}$`)
#     as belt-and-braces. The three probes are resolved INDEPENDENTLY (not
#     chained on each other): an unborn HEAD still correctly reports a real
#     `git_ref` (a symbolic ref name needs no commits to exist) and a real
#     `dirty`, even though `git_sha` is unresolvable — one probe's failure
#     never silently blanks out a sibling probe that actually succeeded.
#   - dirty = true iff `git status --porcelain` (any tracked modification OR
#     any untracked file) is non-empty at resolution time; timeout-guarded
#     (2s) the same way telemetry.sh's runtime_version() guards its own
#     subprocess, so a pathological repo can never hang a hook indefinitely —
#     a timeout yields dirty:null with a reason, never a guessed value.
#
# Emits (via kit_identity_json, compact JSON on stdout):
#   {
#     "resolution": "resolved" | "incomplete",
#     "reason": "<string>" | null,   // set whenever ANY sub-field below could
#                                     // not be resolved, even if resolution
#                                     // stays "resolved" on version alone
#     "version": "<string>" | null,
#     "git_sha": "<40-hex>" | null,
#     "git_ref": "<branch>" | null,  // null on a detached HEAD (never guessed)
#     "dirty": true | false | null
#   }

# _kit_identity_root <start_dir> — echoes the resolved kit root, or nothing
# (rc=1) when no such ancestor exists within the bounded walk.
_kit_identity_root() {
  local dir="$1" depth=0 parent
  while [[ "$depth" -lt 10 ]]; do
    if [[ -f "${dir}/package.json" && -d "${dir}/packaging" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    parent="$(dirname "$dir")"
    [[ "$parent" == "$dir" ]] && return 1
    dir="$parent"
    depth=$((depth + 1))
  done
  return 1
}

# _kit_identity_git_dirty <kit_root> — echoes "true", "false", or "" (unknown:
# git status could not be read, or timed out — NEVER a guessed value). Uses a
# temp file (not command substitution) so the backgrounded git's own exit code
# is observable via `wait`, distinguishing a genuinely-clean (empty, rc=0)
# result from a failed/timed-out one (also empty stdout, but non-zero rc).
_kit_identity_git_dirty() {
  local kit_root="$1" tmp rc pid guard
  tmp=$(mktemp 2>/dev/null) || { printf ''; return; }
  ( git -C "$kit_root" status --porcelain >"$tmp" 2>/dev/null ) &
  pid=$!
  ( sleep 2; kill "$pid" 2>/dev/null ) &
  guard=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$guard" 2>/dev/null
  wait "$guard" 2>/dev/null
  if [[ $rc -ne 0 ]]; then
    rm -f "$tmp" 2>/dev/null
    printf ''
    return
  fi
  if [[ -s "$tmp" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
  rm -f "$tmp" 2>/dev/null
}

# kit_identity_json — the single entry point both telemetry.sh and
# economics-record.sh call. Compact JSON on stdout; never fails (a jq/git
# hiccup degrades to the explicit incomplete/null shape above, never blocks
# the caller).
kit_identity_json() {
  local lib_dir kit_root
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || lib_dir=""
  kit_root=""
  [[ -n "$lib_dir" ]] && kit_root="$(_kit_identity_root "$lib_dir" 2>/dev/null)"

  local version="" git_sha="" git_ref="" dirty=""
  local reasons=()

  if [[ -z "$kit_root" ]]; then
    reasons+=("no kit root (package.json + packaging/) found above ${lib_dir:-<unresolved lib dir>}")
  else
    if command -v jq >/dev/null 2>&1 && [[ -f "${kit_root}/package.json" ]]; then
      version=$(jq -r '.version // empty' "${kit_root}/package.json" 2>/dev/null)
    fi
    [[ -z "$version" ]] && reasons+=("${kit_root}/package.json has no readable .version field")

    if [[ -e "${kit_root}/.git" ]] && command -v git >/dev/null 2>&1; then
      # Every probe below is gated on its OWN exit status, never on stdout emptiness alone --
      # `x=$(cmd 2>/dev/null); rc=$?` captures cmd's real exit code (never a pipeline tail). This
      # matters concretely: on an unborn HEAD (a real `.git`, zero commits) `git rev-parse HEAD`
      # exits 128 but still PRINTS the literal string "HEAD" to stdout (standard git behavior for
      # an unresolvable ref) -- an emptiness-only check would accept that fabricated-looking
      # non-hex string as a real sha. The sha is additionally shape-validated (40 hex) as
      # belt-and-braces so ANY future git behavior that prints something non-empty on failure is
      # still caught, independent of exit-code handling. rev-parse/symbolic-ref/dirty are resolved
      # INDEPENDENTLY (not chained on each other's success) so e.g. an unborn HEAD still correctly
      # reports a real git_ref/dirty even though git_sha is unresolvable -- never let one probe's
      # failure silently blank out a sibling probe that actually succeeded.
      local sha_out sha_rc
      sha_out=$(git -C "$kit_root" rev-parse HEAD 2>/dev/null)
      sha_rc=$?
      if [[ $sha_rc -eq 0 && "$sha_out" =~ ^[0-9a-f]{40}$ ]]; then
        git_sha="$sha_out"
      else
        reasons+=("git rev-parse HEAD did not resolve a real commit at kit root ${kit_root} (exit ${sha_rc}) -- likely an unborn HEAD (no commits yet) or an unresolvable ref")
      fi

      local ref_out ref_rc
      ref_out=$(git -C "$kit_root" symbolic-ref -q --short HEAD 2>/dev/null)
      ref_rc=$?
      if [[ $ref_rc -eq 0 && -n "$ref_out" ]]; then
        git_ref="$ref_out"
      else
        reasons+=("HEAD is detached (or symbolic-ref failed, exit ${ref_rc}) at kit root ${kit_root} -- no branch ref")
      fi

      local dirty_state
      dirty_state=$(_kit_identity_git_dirty "$kit_root")
      case "$dirty_state" in
        true | false) dirty="$dirty_state" ;;
        *) reasons+=("git status could not be read (or timed out) at kit root ${kit_root}") ;;
      esac
    else
      reasons+=("no .git found directly at kit root ${kit_root} (packaged install; git lineage unavailable)")
    fi
  fi

  local resolution="resolved"
  [[ -z "$version" ]] && resolution="incomplete"

  local reason_str=""
  if [[ "${#reasons[@]}" -gt 0 ]]; then
    reason_str=$(printf '%s; ' "${reasons[@]}")
    reason_str="${reason_str%; }"
  fi

  jq -nc \
    --arg resolution "$resolution" \
    --arg reason "$reason_str" \
    --arg version "$version" \
    --arg git_sha "$git_sha" \
    --arg git_ref "$git_ref" \
    --arg dirty "$dirty" \
    '{
      resolution: $resolution,
      reason: (if $reason == "" then null else $reason end),
      version: (if $version == "" then null else $version end),
      git_sha: (if $git_sha == "" then null else $git_sha end),
      git_ref: (if $git_ref == "" then null else $git_ref end),
      dirty: (if $dirty == "true" then true elif $dirty == "false" then false else null end)
    }' 2>/dev/null || printf '{"resolution":"incomplete","reason":"kit identity resolution failed (jq unavailable or errored)","version":null,"git_sha":null,"git_ref":null,"dirty":null}'
}
