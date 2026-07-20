// #799: the config-protection hook's interpreter-write detector (checkInterpreterWriteToProtected)
// blocked any `python3 -c` / `node -e` segment that merely contained a protected-path token as a
// literal substring, with no notion of read vs write. That trained agents into false-positive
// blocks on provably-read-only one-liners, which erodes the hook's real coverage (per the
// hook's own "runtime path construction evades it" admission -- every wrongly-blocked read
// teaches an agent to construct paths at runtime instead).
//
// This suite pins BOTH halves of the fix: the real false positives from 2026-07-20 now pass
// (ALLOW), and the full adversarial write matrix still blocks (BLOCK) -- the read-only grammar
// is a narrow positive allowlist, not a relaxation of the write detector.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const require_ = createRequire(import.meta.url);
const hook = require_(path.join(packageRoot, "scripts", "hooks", "config-protection.js"));
const { isProvablyReadOnlyCommand } = require_(path.join(packageRoot, "scripts", "hooks", "lib", "read-only-grammar.js"));

function runBash(command, cwd = packageRoot) {
  const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
  return hook.run(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// The three real false positives from 2026-07-20 (per #799) -- must now ALLOW.
// ---------------------------------------------------------------------------

test("#799 false positive: python3 -m json.tool on a real checkpoint path allows (was never blocked, locked in as a regression guard)", () => {
  const res = runBash("python3 -m json.tool delivery/x/trust.checkpoint.json");
  assert.equal(res.exitCode, 0);
});

test("#799 false positive: python3 -c reading trust.bundle claims via json.load+open+print now allows", () => {
  const res = runBash(
    `python3 -c "import json;print(json.load(open('.kontourai/flow-agents/slug/trust.bundle'))['claims'][0])"`,
  );
  assert.equal(res.exitCode, 0, res.stderr);
});

test("#799 false positive: compound cd + read-only grep status print on state.json allows (was never blocked, locked in)", () => {
  const res = runBash(`cd /repo && grep -oE '"status":"[a-z]+"' .kontourai/flow-agents/slug/state.json`);
  assert.equal(res.exitCode, 0);
});

test("#799 grammar A: cat piped into python3 -m json.tool allows", () => {
  const res = runBash("cat .kontourai/flow-agents/slug/state.json | python3 -m json.tool");
  assert.equal(res.exitCode, 0);
});

test("#799 grammar B: node -e reading state.json via fs.readFileSync + console.log allows", () => {
  const res = runBash(
    `node -e "console.log(JSON.parse(require('fs').readFileSync('.kontourai/flow-agents/slug/state.json','utf8')).status)"`,
  );
  assert.equal(res.exitCode, 0, res.stderr);
});

test("#799 grammar B: a leading cd prefix before a read-only python -c still allows", () => {
  const res = runBash(
    `cd /repo && python3 -c "print(json.load(open('.kontourai/flow-agents/slug/trust.bundle')))"`,
  );
  assert.equal(res.exitCode, 0, res.stderr);
});

// ---------------------------------------------------------------------------
// Block message gains a read-remediation line (AC2).
// ---------------------------------------------------------------------------

test("blocked interpreter-write message names the read remediation (python3 -m json.tool)", () => {
  const res = runBash(`python3 -c "open('.kontourai/flow-agents/slug/state.json','w').write('{}')"`);
  assert.equal(res.exitCode, 2);
  assert.match(res.stderr, /python3 -m json\.tool/);
});

// ---------------------------------------------------------------------------
// Adversarial suite: every one of these MUST still BLOCK. The read-only grammar is a narrow
// positive allowlist -- it must not create a new write-side gap.
// ---------------------------------------------------------------------------

const mustBlock = [
  ["python3 -c open(...,'w') on state.json", `python3 -c "open('.kontourai/flow-agents/slug/state.json','w')"`],
  [
    "node -e fs.writeFileSync on trust.bundle",
    `node -e "require('fs').writeFileSync('.kontourai/flow-agents/slug/trust.bundle','{}')"`,
  ],
  ["sed -i on trust.checkpoint.json (flat delivery path)", `sed -i 's/a/b/' delivery/trust.checkpoint.json`],
  ["echo redirect to trust.bundle", `echo x > .kontourai/flow-agents/slug/trust.bundle`],
  [
    "json.dump to a protected path via single -c segment",
    `python3 -c "import json;json.dump({'status':'verified'}, open('.kontourai/flow-agents/slug/state.json','w'))"`,
  ],
  [
    "read-looking command with a trailing redirect to the same protected path",
    `python3 -c "print(open('.kontourai/flow-agents/slug/state.json').read())" > .kontourai/flow-agents/slug/state.json`,
  ],
  ["open(...,'r+') is not a pure read mode", `python3 -c "open('.kontourai/flow-agents/slug/trust.bundle','r+')"`],
  [
    "nested-paren open() call hides the write mode from a naive single-level parser",
    `python3 -c "open(__import__('os').path.join('.kontourai','flow-agents','slug','trust.bundle'), 'w')"`,
  ],
  [
    "eval() escape hatch alongside an otherwise read-shaped body",
    `python3 -c "eval(open('.kontourai/flow-agents/slug/trust.bundle').read())"`,
  ],
  [
    "subprocess escape hatch alongside an otherwise read-shaped body",
    `python3 -c "import subprocess,json;print(json.load(open('.kontourai/flow-agents/slug/trust.bundle')))"`,
  ],
  [
    "require(child_process) escape hatch in a node -e body",
    `node -e "const cp=require('child_process');console.log(cp.execSync('cat .kontourai/flow-agents/slug/trust.bundle').toString())"`,
  ],
  [
    "multi-statement body: read+print followed by a hidden write",
    `python3 -c "import json;print(json.load(open('.kontourai/flow-agents/slug/trust.bundle')));open('.kontourai/flow-agents/slug/trust.bundle','a').write('x')"`,
  ],
  [
    "an extra non-cd/cat segment alongside the -c invocation disqualifies the fast pass",
    `ls && python3 -c "print(json.load(open('.kontourai/flow-agents/slug/trust.bundle')))"`,
  ],
  [
    "a python3 - <<EOF heredoc with json.dump to a protected path (pre-existing documented gap -- see note below)",
    `python3 - <<'EOF'\nimport json\njson.dump({"status":"verified"}, open('.kontourai/flow-agents/slug/trust.bundle','w'))\nEOF`,
    { knownGap: true },
  ],
];

for (const [label, cmd, opts] of mustBlock) {
  test(`adversarial (must block): ${label}`, () => {
    const res = runBash(cmd);
    if (opts && opts.knownGap) {
      // #799 discovered, out-of-scope, PRE-EXISTING gap: `python3 - <<EOF` uses a bare `-`
      // (script from stdin), not `-c`, so it never matched INTERPRETER_WRITE_RE before this PR
      // either -- unaffected by the read-only grammar added here (which only ever ALLOWS,
      // never blocks, so it cannot be the cause). Fixing multiline heredoc detection is a
      // new-coverage change explicitly out of scope for the ADR 0018 FROZEN bar-raiser and for
      // #799 (a false-positive fix). Documented here rather than silently dropped so the gap
      // stays visible; see the PR description for the recommended follow-up.
      assert.equal(res.exitCode, 0, "expected the documented pre-existing gap (unblocked) -- update this test if the gap is later closed");
      return;
    }
    assert.equal(res.exitCode, 2, `expected BLOCK for: ${cmd}\ngot stderr: ${res.stderr}`);
  });
}

// ---------------------------------------------------------------------------
// Direct grammar unit tests (lib/read-only-grammar.js), independent of the hook's substring
// pre-filter -- pins the grammar's own decision surface.
// ---------------------------------------------------------------------------

test("isProvablyReadOnlyCommand: grammar unit matrix", () => {
  const deps = { tokenize: hook.tokenize, splitSegments: hook.splitSegments };
  const allow = [
    `python3 -m json.tool state.json`,
    `python -m json.tool state.json`,
    `cat state.json | python3 -m json.tool`,
    `python3 -c "print(json.load(open('trust.bundle')))"`,
    `python3 -c "print(open('trust.bundle').read())"`,
    `node -e "console.log(require('fs').readFileSync('trust.bundle','utf8'))"`,
    `cd /tmp && python3 -c "print(json.load(open('trust.bundle')))"`,
  ];
  const block = [
    ``,
    `python3 -c "open('trust.bundle','w')"`,
    `python3 -c "open('trust.bundle','w').write('x')"`,
    `python3 -c "json.dump({}, open('trust.bundle','w'))"`,
    `node -e "require('fs').writeFileSync('trust.bundle','x')"`,
    `sed -i 's/a/b/' trust.bundle`,
    `perl -e 'print 1' trust.bundle`,
    `python3 -c "print(1)" > trust.bundle`,
    `python3 -c "eval(open('trust.bundle').read())"`,
    `python3 -c "print(1)" "print(2)"`, // two body args -- unrecognized shape
    `ls && python3 -c "print(json.load(open('trust.bundle')))"`, // extra segment
  ];
  for (const cmd of allow) {
    assert.equal(isProvablyReadOnlyCommand(cmd, deps), true, `expected ALLOW: ${cmd}`);
  }
  for (const cmd of block) {
    assert.equal(isProvablyReadOnlyCommand(cmd, deps), false, `expected fall-through (not fast-passed): ${cmd}`);
  }
});
