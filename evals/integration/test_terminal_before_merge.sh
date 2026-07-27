#!/usr/bin/env bash
# Deterministic exact-terminal-head merge boundary coverage. No live provider mutation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
npm run build --silent
node --test \
  src/cli/merge-change-operation-authority.test.mjs \
  src/cli/merge-change-provider.test.mjs

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
SLUG="terminal-merge-fixture"
SESSION="$REPO/.kontourai/flow-agents/$SLUG"
mkdir -p "$REPO" "$SESSION" "$REPO/delivery/$SLUG"
git -C "$REPO" init -q
git -C "$REPO" config user.email "fixture@example.test"
git -C "$REPO" config user.name "fixture"
printf 'base\n' > "$REPO/source.txt"
printf '.kontourai/\n' > "$REPO/.gitignore"
git -C "$REPO" add source.txt .gitignore
git -C "$REPO" commit -qm base
BASE_BRANCH="$(git -C "$REPO" symbolic-ref --short HEAD)"
git -C "$REPO" checkout -qb feature
printf 'reviewed source\n' >> "$REPO/source.txt"
git -C "$REPO" add source.txt
git -C "$REPO" commit -qm feature
FEATURE_HEAD="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" checkout -q "$BASE_BRANCH"
git -C "$REPO" merge --squash feature
git -C "$REPO" commit -qm squash-merge
SQUASH_HEAD="$(git -C "$REPO" rev-parse HEAD)"
if git -C "$REPO" merge-base --is-ancestor "$FEATURE_HEAD" "$SQUASH_HEAD"; then
  echo "FAIL: fixture did not create non-ancestral squash topology" >&2
  exit 1
fi

# Build a distinct, session-bound trust bundle from this run's canonical
# evidence. A foreign-session delivery must never become merge authority merely
# because its bytes are otherwise valid.
node --input-type=module - "$ROOT/.kontourai/flow-agents/kontourai-flow-agents-1000/trust.bundle" "$SESSION/trust.bundle" "$SLUG" <<'NODE'
import fs from "node:fs";
const [source, destination, slug] = process.argv.slice(2);
const bundle = JSON.parse(fs.readFileSync(source, "utf8"));
const replace = (value) => typeof value === "string"
  ? value.replaceAll("kontourai-flow-agents-1000", slug).replaceAll("kontourai/flow-agents#1000", "kontourai/flow-agents#terminal")
  : Array.isArray(value) ? value.map(replace)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]))
      : value;
fs.writeFileSync(destination, `${JSON.stringify(replace(bundle))}\n`);
NODE
cat > "$SESSION/trust.checkpoint.json" <<EOF
{"schema_version":"1.0","slug":"$SLUG","status":"delivered","phase":"release","commit_sha":"$SQUASH_HEAD"}
EOF
cat > "$SESSION/trust.checkpoint.attestation.json" <<'EOF'
{"status":"unsigned","path":"trust.checkpoint.intoto.json"}
EOF
node --input-type=module - "$SESSION" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const session = process.argv[2];
const checkpoint = fs.readFileSync(path.join(session, "trust.checkpoint.json"));
const bundle = JSON.parse(fs.readFileSync(path.join(session, "trust.bundle"), "utf8"));
const statement = {
  _type: "https://in-toto.io/Statement/v1",
  predicateType: "https://hachure.org/v1/bundle",
  subject: [{ name: "trust.checkpoint.json", digest: { sha256: createHash("sha256").update(checkpoint).digest("hex") } }],
  predicate: bundle,
};
fs.writeFileSync(path.join(session, "trust.checkpoint.intoto.json"), `${JSON.stringify(statement)}\n`);
NODE
cp "$SESSION"/trust.* "$REPO/delivery/$SLUG/"
git -C "$REPO" add delivery
git -C "$REPO" commit -qm terminal-delivery

node "$ROOT/build/src/cli.js" merge-change validate-terminal-delivery \
  --session-dir "$SESSION" --head-ref "$BASE_BRANCH" >/dev/null

# Reproduce #981/#992/#999: a later delivery-only follow-up after the feature
# has been squash-merged must not turn non-ancestry into provenance. The only
# difference is the checkpoint's source feature SHA, which is intentionally
# not an ancestor of main's squash history.
sed "s/$SQUASH_HEAD/$FEATURE_HEAD/" "$SESSION/trust.checkpoint.json" > "$TMP/checkpoint.json"
mv "$TMP/checkpoint.json" "$SESSION/trust.checkpoint.json"
node --input-type=module - "$SESSION" "$SQUASH_HEAD" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [session, squashHead] = process.argv.slice(2);
const checkpoint = fs.readFileSync(path.join(session, "trust.checkpoint.json"));
const bundle = JSON.parse(fs.readFileSync(path.join(session, "trust.bundle"), "utf8"));
fs.writeFileSync(path.join(session, "trust.checkpoint.intoto.json"), `${JSON.stringify({ _type: "https://in-toto.io/Statement/v1", predicateType: "https://hachure.org/v1/bundle", subject: [{ name: "trust.checkpoint.json", digest: { sha256: createHash("sha256").update(checkpoint).digest("hex") } }], predicate: bundle })}\n`);
NODE
cp "$SESSION/trust.checkpoint.json" "$REPO/delivery/$SLUG/trust.checkpoint.json"
cp "$SESSION/trust.checkpoint.intoto.json" "$REPO/delivery/$SLUG/trust.checkpoint.intoto.json"
git -C "$REPO" add delivery/$SLUG/trust.checkpoint.json delivery/$SLUG/trust.checkpoint.intoto.json
git -C "$REPO" commit -qm unsafe-delivery-only-followup
if node "$ROOT/build/src/cli.js" merge-change validate-terminal-delivery --session-dir "$SESSION" --head-ref "$BASE_BRANCH" >"$TMP/out" 2>&1; then
  echo "FAIL: post-squash delivery-only follow-up was accepted" >&2
  exit 1
fi
if ! grep -qF 'ancestor-bound delivery-only terminal commit' "$TMP/out"; then
  echo "FAIL: unsafe squash follow-up did not fail with ancestry recovery text" >&2
  cat "$TMP/out" >&2
  exit 1
fi
if ! grep -qF 'flow-agents workflow publish-delivery' "$TMP/out" || ! grep -qF 'exact-head provider checks' "$TMP/out"; then
  echo "FAIL: terminal refusal did not name publish-delivery plus exact-head check refresh recovery" >&2
  cat "$TMP/out" >&2
  exit 1
fi

# A checkpoint/bundle from another session must be refused even if every
# companion is internally digest-valid and committed at the exact terminal head.
node --input-type=module - "$SESSION" "$SQUASH_HEAD" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [session, squashHead] = process.argv.slice(2);
const checkpointPath = path.join(session, "trust.checkpoint.json");
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
checkpoint.slug = "foreign-session";
checkpoint.commit_sha = squashHead;
fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
const bytes = fs.readFileSync(checkpointPath);
const bundle = JSON.parse(fs.readFileSync(path.join(session, "trust.bundle"), "utf8"));
fs.writeFileSync(path.join(session, "trust.checkpoint.intoto.json"), `${JSON.stringify({ _type: "https://in-toto.io/Statement/v1", predicateType: "https://hachure.org/v1/bundle", subject: [{ name: "trust.checkpoint.json", digest: { sha256: createHash("sha256").update(bytes).digest("hex") } }], predicate: bundle })}\n`);
NODE
cp "$SESSION/trust.checkpoint.json" "$REPO/delivery/$SLUG/trust.checkpoint.json"
cp "$SESSION/trust.checkpoint.intoto.json" "$REPO/delivery/$SLUG/trust.checkpoint.intoto.json"
git -C "$REPO" add delivery/$SLUG/trust.checkpoint.json delivery/$SLUG/trust.checkpoint.intoto.json
git -C "$REPO" commit -qm cross-run-terminal-delivery
if node "$ROOT/build/src/cli.js" merge-change validate-terminal-delivery --session-dir "$SESSION" --head-ref "$BASE_BRANCH" >"$TMP/cross-run.out" 2>&1; then
  echo "FAIL: cross-run terminal evidence was accepted" >&2
  exit 1
fi
if ! grep -qF 'canonical delivered release checkpoint' "$TMP/cross-run.out"; then
  echo "FAIL: cross-run terminal evidence did not identify the session-bound checkpoint refusal" >&2
  cat "$TMP/cross-run.out" >&2
  exit 1
fi
