#!/usr/bin/env bash
# Exercise the pinned published Corpus package, with faults in an isolated copy.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/knowledge-purge-gate.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
node -e 'const p = require(process.argv[1]); if (p.version !== "0.1.0-next.5") throw new Error("unexpected Corpus Store version")' "$ROOT_DIR/node_modules/@kontourai/corpus-store/package.json"
mkdir "$WORK_DIR/package"
cp -R "$ROOT_DIR/node_modules/@kontourai/corpus-store/dist" "$WORK_DIR/package/dist"
cp "$ROOT_DIR/node_modules/@kontourai/corpus-store/package.json" "$WORK_DIR/package/package.json"
mkdir "$WORK_DIR/package/node_modules"
YAML_DIR="$(node -e 'const path = require("node:path"); const fs = require("node:fs"); const root = fs.realpathSync(process.argv[1]); console.log(path.dirname(require.resolve("js-yaml/package.json", { paths: [root] })))' "$ROOT_DIR/node_modules/@kontourai/corpus-store")"
ln -s "$YAML_DIR" "$WORK_DIR/package/node_modules/js-yaml"
CORPUS_STORE_ENTRY="$WORK_DIR/package/dist/index.js"
SURFACE_ENTRY="$ROOT_DIR/node_modules/@kontourai/surface/dist/src/index.js"
export CORPUS_STORE_ENTRY SURFACE_ENTRY
TEST_FILE="$ROOT_DIR/kits/knowledge/providers/surface-adapter/packed-purge.test.mjs"
node --test "$TEST_FILE"
PURGE_FILE="$WORK_DIR/package/dist/shared/purge.js"
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
