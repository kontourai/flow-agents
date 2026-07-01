#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

REPO="$TMPDIR_EVAL/repo"
mkdir -p \
  "$REPO/.telemetry" \
  "$REPO/.flow/runs/run-1" \
  "$REPO/.surface/runs/run-2" \
  "$REPO/.veritas/evidence" \
  "$REPO/.veritas/repo-standards" \
  "$REPO/.flow/definitions" \
  "$REPO/.flow-agents/task"

printf '%s\n' '{"event":1}' > "$REPO/.telemetry/full.jsonl"
printf '%s\n' '{"run":1}' > "$REPO/.flow/runs/run-1/state.json"
printf '%s\n' '{"surface":1}' > "$REPO/.surface/runs/run-2/latest.json"
printf '%s\n' '{"evidence":1}' > "$REPO/.veritas/evidence/e.json"
printf '%s\n' '{"durable":1}' > "$REPO/.veritas/repo-map.json"
printf '%s\n' '{"standard":1}' > "$REPO/.veritas/repo-standards/std.json"
printf '%s\n' '{"definition":1}' > "$REPO/.flow/definitions/main.json"
printf '%s\n' '{"state":1}' > "$REPO/.flow-agents/task/state.json"
ln -s "$REPO/.telemetry/full.jsonl" "$REPO/.telemetry/link.jsonl"

if node "$ROOT/scripts/migrate-local-artifacts.mjs" --repo "$REPO" --json > "$TMPDIR_EVAL/dry.json"; then
  if [[ ! -e "$REPO/.kontourai/telemetry/full.jsonl" ]] \
    && node - "$TMPDIR_EVAL/dry.json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!data.summary.dry_run || data.summary.applied) throw new Error("expected dry-run");
const text = JSON.stringify(data);
for (const needle of [".telemetry/full.jsonl", ".flow/runs/run-1/state.json", ".surface/runs/run-2/latest.json", ".veritas/evidence/e.json"]) {
  if (!text.includes(needle)) throw new Error(`missing copy plan ${needle}`);
}
for (const needle of [".veritas/repo-map.json", ".veritas/repo-standards", ".flow/definitions", ".flow-agents"]) {
  if (!text.includes(needle)) throw new Error(`missing durable skip ${needle}`);
}
if (!text.includes("source-is-symlink")) throw new Error("missing symlink skip");
NODE
  then
    _pass "migration script defaults to dry-run and reports generated copies plus durable skips"
  else
    _fail "migration dry-run output was wrong"
  fi
else
  _fail "migration dry-run command failed"
fi

if node "$ROOT/scripts/migrate-local-artifacts.mjs" --repo "$REPO" --apply --include-flow-agents > "$TMPDIR_EVAL/apply.out"; then
  if [[ -f "$REPO/.kontourai/telemetry/full.jsonl" ]] \
    && [[ -f "$REPO/.kontourai/flow/runs/run-1/state.json" ]] \
    && [[ -f "$REPO/.kontourai/surface/runs/run-2/latest.json" ]] \
    && [[ -f "$REPO/.kontourai/veritas/evidence/e.json" ]] \
    && [[ -f "$REPO/.kontourai/flow-agents/task/state.json" ]] \
    && [[ -f "$REPO/.telemetry/full.jsonl" ]] \
    && [[ -f "$REPO/.flow-agents/task/state.json" ]] \
    && [[ ! -e "$REPO/.kontourai/veritas/repo-map.json" ]] \
    && [[ ! -e "$REPO/.kontourai/flow/definitions/main.json" ]]; then
    _pass "migration apply copies only generated allowlisted paths without deleting old files"
  else
    _fail "migration apply copied wrong files or deleted old files"
  fi
else
  _fail "migration apply command failed"
fi

TARGET_SYMLINK_WORKSPACE="$TMPDIR_EVAL/target-symlink-workspace"
TARGET_SYMLINK_REPO="$TARGET_SYMLINK_WORKSPACE/repo"
OUTSIDE="$TMPDIR_EVAL/outside.txt"
mkdir -p "$TARGET_SYMLINK_REPO/.telemetry" "$TARGET_SYMLINK_REPO/.kontourai/telemetry"
printf '%s\n' '{"safe":true}' > "$TARGET_SYMLINK_REPO/.telemetry/full.jsonl"
printf '%s\n' 'outside-original' > "$OUTSIDE"
ln -s "$OUTSIDE" "$TARGET_SYMLINK_REPO/.kontourai/telemetry/full.jsonl"

if node "$ROOT/scripts/migrate-local-artifacts.mjs" --repo "$TARGET_SYMLINK_REPO" --apply --force --json > "$TMPDIR_EVAL/target-symlink.json"; then
  if [[ "$(cat "$OUTSIDE")" == "outside-original" ]] \
    && node - "$TMPDIR_EVAL/target-symlink.json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const text = JSON.stringify(data);
if (!text.includes("target-is-symlink")) throw new Error("missing target symlink skip");
if (data.summary.copies !== 0) throw new Error(`expected no copies, got ${data.summary.copies}`);
NODE
  then
    _pass "migration apply --force refuses target symlinks"
  else
    _fail "migration apply --force followed or failed to report target symlink"
  fi
else
  _fail "migration apply --force target symlink command failed"
fi

exit "$errors"
