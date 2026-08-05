#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

CLI="$ROOT/build/src/cli.js"
KIT="$TMP_DIR/fixture-kit"
mkdir -p "$KIT/flows" "$KIT/payload"
cp "$ROOT/kits/release-evidence/flows/release-evidence.flow.json" "$KIT/flows/review.flow.json"
printf 'alpha from kit\n' >"$KIT/payload/alpha.txt"
printf 'beta from kit\n' >"$KIT/payload/beta.txt"
cat >"$KIT/kit.json" <<'JSON'
{
  "schema_version": "1.0",
  "id": "fixture-kit",
  "name": "Provision Fixture Kit",
  "flows": [{"id":"release-evidence","path":"flows/review.flow.json"}],
  "provisions": [
    {"id":"fixture-kit.alpha","path":"payload/alpha.txt","target":"docs/alpha.txt"},
    {"id":"fixture-kit.beta","path":"payload/beta.txt","target":"config/beta.txt","description":"fixture"}
  ]
}
JSON

echo "=== Kit provisioning integration ==="
npm run build --silent >/dev/null || { fail "build failed"; exit 1; }

if node "$CLI" kit validate "$KIT" >"$TMP_DIR/validate.out" 2>&1; then
  pass "kit validate accepts declared provisions"
else
  fail "kit validate rejected valid provisions"; sed -n '1,80p' "$TMP_DIR/validate.out"
fi

TARGET="$TMP_DIR/consumer"
mkdir -p "$TARGET"
if node "$CLI" kit provision "$KIT" --target "$TARGET" >"$TMP_DIR/provision.out" 2>&1 \
  && cmp -s "$KIT/payload/alpha.txt" "$TARGET/docs/alpha.txt" \
  && cmp -s "$KIT/payload/beta.txt" "$TARGET/config/beta.txt" \
  && node -e 'const m=require(process.argv[1]); if(m.schema_version!=="1.0"||m.kit_id!=="fixture-kit"||m.files.length!==2)process.exit(1)' "$TARGET/.kontourai/flow-agents/provisions/fixture-kit.json"; then
  pass "provision copies exact content and writes the two-entry manifest"
else
  fail "positive provision failed"; sed -n '1,100p' "$TMP_DIR/provision.out"
fi

printf 'consumer-owned alpha\n' >"$TARGET/docs/alpha.txt"
printf 'changed source beta\n' >"$KIT/payload/beta.txt"
if node "$CLI" kit provision "$KIT" --target "$TARGET" >"$TMP_DIR/conflict.out" 2>&1; then
  fail "create-only conflict unexpectedly succeeded"
elif [[ "$(cat "$TARGET/docs/alpha.txt")" == "consumer-owned alpha" ]] \
  && [[ "$(cat "$TARGET/config/beta.txt")" == "beta from kit" ]] \
  && rg -q 'docs/alpha.txt' "$TMP_DIR/conflict.out" \
  && rg -q 'config/beta.txt' "$TMP_DIR/conflict.out"; then
  pass "conflict is nonzero, names all conflicts, and overwrites nothing"
else
  fail "conflict handling was not atomic or diagnostic"; sed -n '1,100p' "$TMP_DIR/conflict.out"
fi

if node "$CLI" kit provision "$KIT" --target "$TARGET" --force >"$TMP_DIR/force.out" 2>&1 \
  && cmp -s "$KIT/payload/alpha.txt" "$TARGET/docs/alpha.txt" \
  && cmp -s "$KIT/payload/beta.txt" "$TARGET/config/beta.txt"; then
  pass "--force overwrites declared destinations"
else
  fail "--force did not overwrite"; sed -n '1,100p' "$TMP_DIR/force.out"
fi

DRY="$TMP_DIR/dry-consumer"
mkdir -p "$DRY"
if node "$CLI" kit provision "$KIT" --target "$DRY" --dry-run >"$TMP_DIR/dry.out" 2>&1 \
  && [[ ! -e "$DRY/docs/alpha.txt" && ! -e "$DRY/.kontourai" ]] \
  && rg -q 'would provision' "$TMP_DIR/dry.out"; then
  pass "--dry-run prints the plan and writes nothing"
else
  fail "--dry-run wrote state or omitted its plan"; sed -n '1,100p' "$TMP_DIR/dry.out"
fi

INVALID="$TMP_DIR/invalid-kit"
cp -R "$KIT" "$INVALID"
node -e 'const fs=require("fs"),p=process.argv[1],m=JSON.parse(fs.readFileSync(p));m.provisions[0].target="../escape.txt";m.provisions[1].target="/absolute.txt";fs.writeFileSync(p,JSON.stringify(m,null,2))' "$INVALID/kit.json"
if node "$CLI" kit validate "$INVALID" >"$TMP_DIR/invalid-validate.out" 2>&1; then
  fail "kit validate accepted traversal and absolute targets"
elif node "$CLI" kit provision "$INVALID" --target "$DRY" >"$TMP_DIR/invalid-provision.out" 2>&1; then
  fail "kit provision accepted an invalid kit"
elif rg -q 'traversal' "$TMP_DIR/invalid-validate.out" && rg -q 'must be relative' "$TMP_DIR/invalid-validate.out"; then
  pass "validation and provisioning refuse traversal and absolute targets"
else
  fail "unsafe target diagnostics were incomplete"; sed -n '1,100p' "$TMP_DIR/invalid-validate.out"
fi

HOME_FIXTURE="$TMP_DIR/kit-home"
mkdir -p "$HOME_FIXTURE"
if node "$CLI" kit install "$KIT" --dest "$HOME_FIXTURE" >"$TMP_DIR/install.out" 2>&1 \
  && node "$CLI" kit activate --dest "$HOME_FIXTURE" --source-root "$ROOT" >"$TMP_DIR/activate.out" 2>&1 \
  && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!r.skipped_assets.some(x=>x.asset_class==="provisions"&&/not activated/.test(x.reason)))process.exit(1)' "$TMP_DIR/activate.out"; then
  pass "codex-local activation explicitly skips provisions"
else
  fail "activation did not report provisions as skipped"; sed -n '1,120p' "$TMP_DIR/activate.out"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Kit provisioning integration passed."
  exit 0
fi
echo "Kit provisioning integration failed with $errors error(s)."
exit 1
