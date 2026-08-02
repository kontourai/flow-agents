#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
HELPER="$ROOT/scripts/hooks/lib/effective-flow-agents-config.js"

git init -q -b main "$REPO"
git -C "$REPO" config user.name Fixture
git -C "$REPO" config user.email fixture@example.invalid
printf 'fixture\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm initial
mkdir -p "$REPO/.flow-agents/config"
cat > "$REPO/.flow-agents/config/core.config.json" <<'JSON'
{"schema_version":"1.0","goal_fit":{"mode":"block","max_blocks":4,"recheck":false,"backstop":"block","backstop_timeout_ms":120000,"require_sidecars":true,"require_critique":false}}
JSON
git -C "$REPO" add .flow-agents/config/core.config.json
git -C "$REPO" commit -qm config

REPO="$REPO" HELPER="$HELPER" NODE_ENV=production FLOW_AGENTS_GOAL_FIT_MODE=off FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=1 FLOW_AGENTS_GOAL_FIT_RECHECK=true FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip FLOW_AGENTS_REQUIRE_SIDECARS=false node - <<'NODE'
const assert = require('node:assert/strict');
const config = require(process.env.HELPER).resolveGoalFitConfig(process.env.REPO);
assert.equal(config.state, 'committed');
assert.equal(config.goal_fit.mode, 'block');
assert.equal(config.goal_fit.max_blocks, 4);
assert.equal(config.goal_fit.recheck, false);
assert.equal(config.goal_fit.backstop, 'block');
assert.equal(config.goal_fit.require_sidecars, true);
assert.equal(config.rejected_environment_overrides.length, 5);
NODE

# Development remains compatible with the legacy mode and backstop spellings.
REPO="$REPO" HELPER="$HELPER" NODE_ENV=development FLOW_AGENTS_GOAL_FIT_MODE=off FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip node - <<'NODE'
const assert = require('node:assert/strict');
const config = require(process.env.HELPER).resolveGoalFitConfig(process.env.REPO);
assert.equal(config.goal_fit.mode, 'off');
assert.equal(config.goal_fit.backstop, 'skip');
NODE
REPO="$REPO" HELPER="$HELPER" NODE_ENV=development FLOW_AGENTS_GOAL_FIT_MODE=warn FLOW_AGENTS_GOAL_FIT_BACKSTOP=warn node - <<'NODE'
const assert = require('node:assert/strict');
const config = require(process.env.HELPER).resolveGoalFitConfig(process.env.REPO);
assert.equal(config.goal_fit.mode, 'warn');
assert.equal(config.goal_fit.backstop, 'off');
NODE

printf '{not json}\n' > "$REPO/.flow-agents/config/core.config.json"
git -C "$REPO" add .flow-agents/config/core.config.json
git -C "$REPO" commit -qm invalid
REPO="$REPO" HELPER="$HELPER" node - <<'NODE'
const assert = require('node:assert/strict');
const config = require(process.env.HELPER).resolveGoalFitConfig(process.env.REPO);
assert.equal(config.state, 'invalid');
assert.equal(config.goal_fit.mode, 'block');
assert.equal(config.goal_fit.require_sidecars, true);
assert.equal(config.goal_fit.recheck, false);
NODE

# A genuine non-Git consumer root preserves historical defaults. A marked Git
# root with corrupt HEAD or a corrupt committed blob remains fail-closed.
MISSING="$TMP/not-a-repository"
MISSING="$MISSING" HELPER="$HELPER" node - <<'NODE'
const assert = require('node:assert/strict');
const config = require(process.env.HELPER).resolveGoalFitConfig(process.env.MISSING);
assert.equal(config.state, 'default');
assert.equal(config.goal_fit.mode, 'warn');
assert.equal(config.goal_fit.recheck, false);
NODE

CORRUPT_HEAD="$TMP/corrupt-head"
git init -q -b main "$CORRUPT_HEAD"
git -C "$CORRUPT_HEAD" config user.name Fixture
git -C "$CORRUPT_HEAD" config user.email fixture@example.invalid
printf 'fixture\n' > "$CORRUPT_HEAD/README.md"
git -C "$CORRUPT_HEAD" add README.md
git -C "$CORRUPT_HEAD" commit -qm initial
printf 'ref: refs/heads/missing\n' > "$CORRUPT_HEAD/.git/HEAD"
REPO="$CORRUPT_HEAD" HELPER="$HELPER" node - <<'NODE'
const assert = require('node:assert/strict');
const config = require(process.env.HELPER).resolveGoalFitConfig(process.env.REPO);
assert.equal(config.state, 'invalid');
assert.equal(config.goal_fit.mode, 'block');
assert.equal(config.goal_fit.recheck, false);
NODE

CORRUPT_BLOB="$TMP/corrupt-blob"
git init -q -b main "$CORRUPT_BLOB"
git -C "$CORRUPT_BLOB" config user.name Fixture
git -C "$CORRUPT_BLOB" config user.email fixture@example.invalid
printf 'fixture\n' > "$CORRUPT_BLOB/README.md"
mkdir -p "$CORRUPT_BLOB/.flow-agents/config"
printf '%s\n' '{"schema_version":"1.0","goal_fit":{"mode":"warn","max_blocks":3,"recheck":false,"backstop":"block","backstop_timeout_ms":120000,"require_sidecars":false,"require_critique":false}}' > "$CORRUPT_BLOB/.flow-agents/config/core.config.json"
git -C "$CORRUPT_BLOB" add .
git -C "$CORRUPT_BLOB" commit -qm config
BLOB_SHA="$(git -C "$CORRUPT_BLOB" rev-parse HEAD:.flow-agents/config/core.config.json)"
chmod u+w "$CORRUPT_BLOB/.git/objects/${BLOB_SHA:0:2}/${BLOB_SHA:2}"
printf 'corrupt' > "$CORRUPT_BLOB/.git/objects/${BLOB_SHA:0:2}/${BLOB_SHA:2}"
REPO="$CORRUPT_BLOB" HELPER="$HELPER" node - <<'NODE'
const assert = require('node:assert/strict');
const config = require(process.env.HELPER).resolveGoalFitConfig(process.env.REPO);
assert.equal(config.state, 'invalid');
assert.equal(config.goal_fit.mode, 'block');
assert.equal(config.goal_fit.recheck, false);
NODE

echo "Goal-fit committed config integration passed."
