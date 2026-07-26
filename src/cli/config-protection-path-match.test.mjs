// #682: the config-protection hook's interpreter-write detector decided "this command touches a
// protected gate file" by asking whether the command string CONTAINED a protected token
// (`state.json`, `trust.bundle`, ...) as a bare substring, and then asked whether the TOKEN
// LITERAL -- not the path from the command -- was inside a declared artifact root. A bare
// basename is always ambiguous to that resolver, so every occurrence failed closed. Two
// independent false-positive classes followed:
//
//   1. Substring, not path: `x-trust.bundle.json`, `effective-state.json` and `notes.bashrc`
//      are different files that merely contain the token text, and they blocked.
//   2. Location-blind: a file in a session scratch dir OUTSIDE the repo entirely blocked, and
//      so did a pure READ of it (`python3 -m json.tool <file> 2>&1` falls through the #799
//      read-only grammar, then hit the substring matcher).
//
// The fix recovers the actual path candidate around each token occurrence -- on path-component
// boundaries -- and hands it to the same fail-closed shape + declared-root decision the
// redirect/tee and cp/mv detectors already use. This narrows a false-positive class ONLY: no
// evasion-pattern rule is added (ADR 0018 FROZEN bar-raiser is unaffected), and every form
// whose destination genuinely cannot be established (bare basename, shell expansion,
// truncating command substitution, glob, relative path under an in-command `cd`) still fails
// closed exactly as before.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const require_ = createRequire(import.meta.url);
const hook = require_(path.join(packageRoot, "scripts", "hooks", "config-protection.js"));

// Token spellings are assembled at runtime so this file's own text cannot be mistaken for a
// protected path by any coarse scanner reading it (the very confusion #682 is about).
const BUNDLE = ["trust", "bundle"].join(".");
const STATE = ["state", "json"].join(".");
const CHECKPOINT = ["trust", "checkpoint", "json"].join(".");
const SETTINGS = [".claude/", "settings.json"].join("");
const Q = String.fromCharCode(34);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fa-682-"));
}

function runBash(command, cwd = packageRoot) {
  return hook.run(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }));
}

function artifactPath(base, file = STATE) {
  return path.join(base, ".kontourai", "flow-agents", "slug", file);
}

// ---------------------------------------------------------------------------
// TRUE POSITIVES -- a genuine write to a protected gate file must still be refused.
// These are the reason the substring matcher existed; none of them may regress.
// ---------------------------------------------------------------------------

const mustBlock = [
  ["direct repo-relative write to the sidecar " + STATE,
    `node -e ${Q}require('fs').writeFileSync('.kontourai/flow-agents/slug/${STATE}','{}')${Q}`],
  ["direct repo-relative write to the sidecar " + BUNDLE,
    `python3 -c ${Q}open('.kontourai/flow-agents/slug/${BUNDLE}','w').write('{}')${Q}`],
  ["sed -i in-place edit of the sidecar " + BUNDLE,
    `sed -i 's/a/b/' .kontourai/flow-agents/slug/${BUNDLE}`],
  ["sed -i in-place edit of the delivery CI anchor",
    `sed -i 's/a/b/' delivery/${CHECKPOINT}`],
  ["perl -e naming the sidecar " + STATE,
    `perl -e 'print' .kontourai/flow-agents/slug/${STATE}`],
  ["write to the current.json routing pointer",
    `node -e ${Q}require('fs').writeFileSync('.kontourai/flow-agents/current.json','{}')${Q}`],
  ["json.tool outfile form targeting the sidecar " + BUNDLE,
    `python3 -m json.tool in.json .kontourai/flow-agents/slug/${BUNDLE}`],
  ["deprecated .flow-agents runtime spelling",
    `sed -i 's/a/b/' .flow-agents/slug/${STATE}`],
  ["`./`-prefixed spelling of the same sidecar path",
    `node -e ${Q}require('fs').writeFileSync('./.kontourai/flow-agents/slug/${STATE}','{}')${Q}`],
  ["case-folded spelling (defended filesystems are commonly case-insensitive)",
    `sed -i 's/a/b/' .KONTOURAI/FLOW-AGENTS/SLUG/${STATE.toUpperCase()}`],
  ["shell profile kill switch (global token, never root-scoped)",
    `sed -i 's/a/b/' ~/.bashrc`],
  ["settings kill switch (global token, never root-scoped)",
    `node -e ${Q}require('fs').writeFileSync('${SETTINGS}','x')${Q}`],
];

for (const [label, cmd] of mustBlock) {
  test(`#682 true positive (must still block): ${label}`, () => {
    const res = runBash(cmd);
    assert.equal(res.exitCode, 2, `expected BLOCK for: ${cmd}\ngot stderr: ${res.stderr}`);
  });
}

test("#682: an absolute path into this repo's own declared root still blocks", () => {
  const res = runBash(`python3 -c ${Q}open('${artifactPath(packageRoot, BUNDLE)}','w')${Q}`);
  assert.equal(res.exitCode, 2, res.stderr);
});

// --- fail-closed forms: the destination cannot be established, so the block stays ---

const mustFailClosed = [
  ["bare basename with no directory context (#783 contract)",
    `node -e ${Q}require('fs').writeFileSync('${STATE}','x')${Q}`],
  ["path assembled through nested calls, leaving only a bare token",
    `python3 -c ${Q}open(__import__('os').path.join('.kontourai','flow-agents','slug','${BUNDLE}'), 'w')${Q}`],
  ["bare $VAR expansion in an artifact-shaped path",
    `node -e ${Q}require('fs').writeFileSync('$T/.kontourai/flow-agents/slug/${STATE}','{}')${Q}`],
  ["${VAR} expansion in an artifact-shaped path",
    `node -e ${Q}require('fs').writeFileSync('\${T}/.kontourai/flow-agents/slug/${STATE}','{}')${Q}`],
  ["command substitution truncating the path prefix",
    `node -e ${Q}require('fs').writeFileSync('$(pwd)/.kontourai/flow-agents/slug/${STATE}','{}')${Q}`],
  ["glob truncating the path prefix",
    `sed -i 's/a/b/' .kontourai/flow-agents/*/${STATE}`],
  ["relative path under an in-command cd (resolution is unsound)",
    `cd sub && node -e ${Q}require('fs').writeFileSync('.kontourai/flow-agents/slug/${STATE}','{}')${Q}`],
  ["a quoted expansion glued to the path prefix",
    `sed -i 's/a/b/' ${Q}$D${Q}/.kontourai/flow-agents/slug/${STATE}`],
  ["a runtime concatenation supplying the path prefix",
    `node -e ${Q}require('fs').writeFileSync(dir+'/.kontourai/flow-agents/slug/${STATE}','{}')${Q}`],
];

for (const [label, cmd] of mustFailClosed) {
  test(`#682 fail-closed (destination unknowable, must still block): ${label}`, () => {
    const res = runBash(cmd, tmpdir());
    assert.equal(res.exitCode, 2, `expected BLOCK for: ${cmd}\ngot stderr: ${res.stderr}`);
  });
}

// ---------------------------------------------------------------------------
// #1004 security review: two execution-verified bypasses this redesign introduced. Both exist
// because a real resolved candidate now flows through a path that `main` never reached (it fed
// the bare token literal to the resolver, which fails closed for any basename). Pinned with the
// reviewer's proof-of-concept commands.
// ---------------------------------------------------------------------------

test("#1004 finding 1: brace expansion cannot truncate into an innocent-looking candidate", () => {
  // Leftward expansion stops at the comma and yields `other}/<state file>` -- not a bare
  // basename, no expansion, no glob. It must fail closed on the truncation itself, because the
  // separator that stopped the expansion is what decides where the write lands.
  const braced = `.kontourai/flow-agents/{slug,other}/${STATE}`;
  assert.equal(runBash(`sed -i '' 's/executing/planning/' ${braced}`).exitCode, 2);
  // The class, not the instance: every metacharacter that can truncate an expansion fails the
  // same way. Only whitespace and a `--flag=` value open an unquoted path literal.
  for (const prefix of [",", "?", "[", "]", "+", ":", "(", ")", "*", "%", "@", "!", "^"]) {
    const cmd = `sed -i '' 's/a/b/' x${prefix}.kontourai/flow-agents/slug/${STATE}`;
    assert.equal(runBash(cmd).exitCode, 2, `prefix ${prefix} must fail closed:\n${cmd}`);
  }
  // ...while the two proven word-opening contexts still resolve normally.
  assert.equal(runBash(`sed -i '' 's/a/b/' .kontourai/flow-agents/slug/${STATE}`).exitCode, 2);
  assert.equal(runBash(`sed -i '' --file=.kontourai/flow-agents/slug/${STATE}`).exitCode, 2);
});

test("#1004 finding 2: an argument-less cd with no trailing space still trips the cd guard", () => {
  // `cd;` / `cd&&` / `cd|` really do change directory (to $HOME), so relative resolution is
  // unsound and a relative candidate must fail closed -- the guard previously demanded
  // whitespace or end-of-string after the word.
  const fakeHome = tmpdir();
  const victim = path.join(fakeHome, ".kontourai", "flow-agents", "victim-slug");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, STATE), "{}");
  const hop = path.join(fakeHome, "hop");
  fs.symlinkSync(victim, hop);
  const elsewhere = tmpdir();
  for (const lead of ["cd;", "cd&&", "cd|", "(cd)", "\\cd;", "pushd;", "popd;"]) {
    const cmd = `${lead} sed -i '' 's/{}/forged/' ${path.join(hop, STATE)}`;
    assert.equal(runBash(cmd, elsewhere).exitCode, 2, `bare directory change must fail closed:\n${cmd}`);
  }
  // The same guard is shared with the redirect detector, where the identical bare-`cd` shape
  // was a PRE-EXISTING gap on main (the reviewer flagged it as out of scope). Fixing the guard
  // closes it there too, so pin it rather than let it silently regress.
  assert.ok(
    hook.checkRedirectToProtected(`cd; echo forged > ${path.join(hop, STATE)}`, elsewhere),
    "redirect detector must also see an argument-less cd",
  );
});

test("#1004 re-review: incidental `cd` text is not a directory change (over-block regression)", () => {
  // The cd guard answers "does a directory-changing builtin RUN here?", so only command-position
  // text can answer it. Scanning a de-quoted copy of the whole command let prose inside a string
  // literal trip it -- the reviewer's case blocked with no `cd` anywhere in the command.
  // Targets are RELATIVE on purpose: that is what makes the guard load-bearing for the verdict.
  const scratch = tmpdir();
  const proseAllowed = [
    `sed -i '' 's/replace me;cd; also/updated/' scratch/${STATE}`,
    `sed -i '' 's/x;cd&& y/z/' scratch/${STATE}`,
    `sed -i ${Q}s/a;cd| b/c/${Q} scratch/${STATE}`,
    `node -e ${Q}require('fs').writeFileSync('scratch/${STATE}','then;cd; done')${Q}`,
    `sed -i '' 's/recd;/x/' scratch/${STATE}`,
    `echo 'cd;' && sed -i '' 's/a/b/' scratch/${STATE}`,
  ];
  for (const cmd of proseAllowed) {
    assert.equal(runBash(cmd, scratch).exitCode, 0, `incidental cd text must not block:\n${cmd}`);
  }
  // ...while a real directory change in command position still fails closed, including the
  // forms the tokenizer has to see through: quote concatenation, env prefixes, and keywords.
  for (const lead of ["cd;", "cd&&", "cd|", "(cd)", "\\cd;", 'c""d;', "FOO=bar cd;", "time cd;", "do cd;"]) {
    const cmd = `${lead} sed -i '' 's/a/b/' scratch/.kontourai/flow-agents/slug/${STATE}`;
    assert.equal(runBash(cmd, scratch).exitCode, 2, `real directory change must fail closed:\n${cmd}`);
  }
});

test("#682: a bare basename resolved from a cwd INSIDE a session dir still blocks", () => {
  const res = runBash(
    `node -e ${Q}require('fs').writeFileSync('${STATE}','x')${Q}`,
    path.join(packageRoot, ".kontourai", "flow-agents", "slug"),
  );
  assert.equal(res.exitCode, 2, res.stderr);
});

test("#682: a gate-file SHAPE blocks even outside every declared root (no scoping relief here)", () => {
  // Deliberate asymmetry with the redirect/tee/cp detectors, which DO grant #783 declared-root
  // relief so scratch fixtures stay authorable: an interpreter body is not an unambiguous write
  // target, and these sidecar tokens never had scoping relief before #682 either. Pinned
  // because it is the shape `evals/integration/test_hook_category_behaviors.sh` exercises with
  // a canonical `/repo/...` path that exists on no machine.
  assert.equal(runBash(`sed -i 's/a/b/' ${artifactPath(tmpdir())}`).exitCode, 2);
  assert.equal(
    runBash(`node -e ${Q}require('fs').writeFileSync('/repo/.kontourai/flow-agents/my-slug/${STATE}', data)${Q}`).exitCode,
    2,
  );
  // ...while the redirect detector keeps its #783 relief, unchanged by this PR.
  assert.equal(runBash(`echo x > ${artifactPath(tmpdir())}`).exitCode, 0);
});

test("#682: an artifact path inside a NON-declared sibling git checkout still blocks (F3 class)", () => {
  const sibling = tmpdir();
  fs.mkdirSync(path.join(sibling, ".git"), { recursive: true });
  const res = runBash(`sed -i 's/a/b/' ${artifactPath(sibling)}`);
  assert.equal(res.exitCode, 2, res.stderr);
});

test("#682: a symlink laundering the artifact-root spelling still blocks (F4 class)", () => {
  const scratch = tmpdir();
  const workspace = path.join(tmpdir(), "ws");
  const artifactRoot = path.join(workspace, ".kontourai", "flow-agents");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const hop = path.join(scratch, "hop"); // spelling shows no .kontourai
  fs.symlinkSync(artifactRoot, hop);
  const origEnv = process.env.SA_PROTECTED_WORKSPACE_ROOTS;
  process.env.SA_PROTECTED_WORKSPACE_ROOTS = workspace;
  try {
    assert.ok(
      hook.checkInterpreterWriteToProtected(`sed -i 's/a/b/' ${path.join(hop, "slug", STATE)}`, scratch),
      "a canonicalized artifact path must block regardless of the visible spelling",
    );
  } finally {
    if (origEnv === undefined) delete process.env.SA_PROTECTED_WORKSPACE_ROOTS;
    else process.env.SA_PROTECTED_WORKSPACE_ROOTS = origEnv;
  }
});

// ---------------------------------------------------------------------------
// FALSE POSITIVES -- every one of these BLOCKED before the fix. Each is either a read, or a
// path whose name merely contains a protected token, or a path outside the repo root.
// ---------------------------------------------------------------------------

test("#682 recurrence 1: json.tool READ of a scratch file whose name contains the token allows", () => {
  // `2>&1` puts the segment past the #799 read-only grammar's charset gate and past
  // isJsonToolWriteShape's fail-closed operand count, so it reached the substring matcher.
  const scratch = tmpdir();
  const res = runBash(`python3 -m json.tool ${path.join(scratch, `review-${BUNDLE}.json`)} 2>&1`);
  assert.equal(res.exitCode, 0, res.stderr);
});

test("#682 recurrence 2: reading a file OUTSIDE the repo that is literally named the token allows", () => {
  const scratch = tmpdir();
  const res = runBash(`python3 -c ${Q}print(open('${path.join(scratch, BUNDLE)}').read())${Q}`);
  assert.equal(res.exitCode, 0, res.stderr);
});

const mustAllow = [
  ["node -e read of an out-of-repo file whose name contains the token",
    (scratch) => `node -e ${Q}console.log(require('fs').readFileSync('${path.join(scratch, `x-${BUNDLE}.json`)}','utf8'))${Q}`],
  ["sed -i on an out-of-repo file whose name contains the token",
    (scratch) => `sed -i '' 's/a/b/' ${path.join(scratch, `my-${STATE}.bak`)}`],
  ["write to an out-of-repo file literally named the token",
    (scratch) => `node -e ${Q}require('fs').writeFileSync('${path.join(scratch, BUNDLE)}','{}')${Q}`],
  ["a file named notes.bashrc is not a shell profile",
    (scratch) => `sed -i 's/a/b/' ${path.join(scratch, "notes.bashrc")}`],
];

for (const [label, build] of mustAllow) {
  test(`#682 false positive (must now allow): ${label}`, () => {
    const res = runBash(build(tmpdir()));
    assert.equal(res.exitCode, 0, `expected ALLOW, got block:\n${res.stderr}`);
  });
}

test("#682 original report: a repo path whose basename merely ends with the token allows", () => {
  // `build/effective-state.json` is not the gate file; it contains the token as a substring.
  const res = runBash(`node -e ${Q}require('fs').writeFileSync('build/effective-${STATE}','{}')${Q}`);
  assert.equal(res.exitCode, 0, res.stderr);
});

test("#682: an unprotected repo path that happens to be named like the gate file allows", () => {
  // `build/<state file>` is inside the repo but outside every declared artifact sub-root, so
  // the shape check (not the basename) is what decides.
  const res = runBash(`node -e ${Q}require('fs').writeFileSync('build/${STATE}','{}')${Q}`);
  assert.equal(res.exitCode, 0, res.stderr);
});

// ---------------------------------------------------------------------------
// Unaffected detectors -- the #682 change touches the interpreter detector only.
// ---------------------------------------------------------------------------

test("#682: redirect, tee and cp/mv detectors are unchanged", () => {
  assert.equal(runBash(`echo x > .kontourai/flow-agents/slug/${STATE}`).exitCode, 2);
  assert.equal(runBash(`echo x | tee .kontourai/flow-agents/slug/${BUNDLE}`).exitCode, 2);
  assert.equal(runBash(`cp forged.json delivery/${BUNDLE}`).exitCode, 2);
  assert.equal(runBash("git commit --no-verify -m x").exitCode, 2);
  assert.equal(runBash(`echo x > ${artifactPath(tmpdir())}`).exitCode, 0);
});

test("#682: Write/Edit path protection is unchanged (substring names are not gate files)", () => {
  const blocked = hook.run(JSON.stringify({
    tool_name: "Write",
    tool_input: { path: `/repo/.kontourai/flow-agents/slug/${STATE}` },
  }));
  assert.equal(blocked.exitCode, 2, blocked.stderr);
  const allowed = hook.run(JSON.stringify({
    tool_name: "Write",
    tool_input: { path: `/repo/build/effective-${STATE}` },
  }));
  assert.equal(allowed.exitCode, 0, allowed.stderr);
});
