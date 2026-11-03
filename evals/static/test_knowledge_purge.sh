#!/usr/bin/env bash
# Build the unpublished Corpus branch at a pinned commit, install its tarball
# outside the repository, and prove the kit adapter seam catches a lost cascade.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/knowledge-purge-gate.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
CORPUS_REV=de8450e2906796e0019ed46bc73014a5d259bde8

git clone --quiet --no-checkout https://github.com/kontourai/corpus.git "$WORK_DIR/corpus"
git -C "$WORK_DIR/corpus" checkout --quiet --detach "$CORPUS_REV"
test "$(git -C "$WORK_DIR/corpus" rev-parse HEAD)" = "$CORPUS_REV"
(cd "$WORK_DIR/corpus" && npm ci --ignore-scripts && npm run build --workspace=@kontourai/corpus-store)
mkdir "$WORK_DIR/pack" "$WORK_DIR/consumer"
(cd "$WORK_DIR/corpus" && npm pack --workspace=@kontourai/corpus-store --pack-destination "$WORK_DIR/pack")
printf '{"private":true,"type":"module"}\n' > "$WORK_DIR/consumer/package.json"
(cd "$WORK_DIR/consumer" && npm install --ignore-scripts --no-save "$WORK_DIR/pack/kontourai-corpus-store-0.1.0-next.0.tgz")
CORPUS_STORE_ENTRY="$WORK_DIR/consumer/node_modules/@kontourai/corpus-store/dist/index.js"
SURFACE_ENTRY="$ROOT_DIR/node_modules/@kontourai/surface/dist/src/index.js"
export CORPUS_STORE_ENTRY SURFACE_ENTRY
TEST_FILE="$ROOT_DIR/kits/knowledge/providers/surface-adapter/packed-purge.test.mjs"
node --test "$TEST_FILE"
PURGE_FILE="$WORK_DIR/consumer/node_modules/@kontourai/corpus-store/dist/shared/purge.js"
cp "$PURGE_FILE" "$WORK_DIR/purge-original.js"
node --input-type=module - "$PURGE_FILE" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const before = readFileSync(file, 'utf8');
const rule = 'const cascaded = ordered.filter((r) => affected.has(r.id) && !alive.has(r.id)).map((r) => r.id);';
if (!before.includes(rule) || before.indexOf(rule) !== before.lastIndexOf(rule)) throw new Error('cascade fault target changed');
writeFileSync(file, before.replace(rule, 'const cascaded = [];'));
JS
if node --test --test-reporter=tap "$TEST_FILE" > "$WORK_DIR/fault.log" 2>&1; then
  echo 'FAIL: disabling the cascade did not fail conformance' >&2
  exit 1
fi
if ! grep -q 'not ok .*default: purge round-trips' "$WORK_DIR/fault.log" ||
   ! grep -q 'not ok .*vault: purge round-trips' "$WORK_DIR/fault.log" ||
   [[ "$(grep -c 'sole dependent must cascade' "$WORK_DIR/fault.log")" -ne 2 ]]; then
  cat "$WORK_DIR/fault.log" >&2
  echo 'FAIL: cascade fault failed for an unexpected reason' >&2
  exit 1
fi
cp "$WORK_DIR/purge-original.js" "$PURGE_FILE"
node --test "$TEST_FILE"
echo 'PASS: kit Corpus-backed adapters and cascade fault control'
