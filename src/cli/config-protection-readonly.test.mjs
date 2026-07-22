// #799: the config-protection hook's interpreter-write detector (checkInterpreterWriteToProtected)
// blocked any `python3 -c` / `node -e` segment that merely contained a protected-path token as a
// literal substring, with no notion of read vs write. That trained agents into false-positive
// blocks on provably-read-only reads, which erodes the hook's real coverage (every wrongly-
// blocked read teaches an agent to construct paths at runtime instead).
//
// v2 (post-adversarial-review): the fix is an EXACT-TEMPLATE allowlist -- only
// `<py> -m json.tool <path>` and `cat <path> | <py> -m json.tool` fast-pass, under a raw
// charset gate that structurally excludes quotes, expansions, redirections, and every shell
// separator except a single `|`. Interpreter-body analysis ("Grammar B") was removed: review
// showed it was a deny-list, not a proof. Blocked reads get a remediation hint naming the
// sanctioned idiom, so the false-positive COST is fixed even though arbitrary read one-liners
// stay blocked.
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
// Sanctioned read idioms -- must ALLOW.
// ---------------------------------------------------------------------------

test("#799 sanctioned read: python3 -m json.tool on a real checkpoint path allows", () => {
  const res = runBash("python3 -m json.tool delivery/x/trust.checkpoint.json");
  assert.equal(res.exitCode, 0, res.stderr);
});

test("#799 sanctioned read: json.tool directly on a protected trust.bundle path allows", () => {
  const res = runBash("python3 -m json.tool .kontourai/flow-agents/slug/trust.bundle");
  assert.equal(res.exitCode, 0, res.stderr);
});

test("#799 sanctioned read: cat piped into python3 -m json.tool allows", () => {
  const res = runBash("cat .kontourai/flow-agents/slug/state.json | python3 -m json.tool");
  assert.equal(res.exitCode, 0, res.stderr);
});

test("#799: compound cd + read-only grep status print on state.json allows (no interpreter token; was never blocked, locked in)", () => {
  const res = runBash(`cd /repo && grep -oE '"status":"[a-z]+"' .kontourai/flow-agents/slug/state.json`);
  assert.equal(res.exitCode, 0);
});

// ---------------------------------------------------------------------------
// v2 regression pins: interpreter-body reads that v1's Grammar B fast-passed now BLOCK, and
// the block message names the sanctioned idiom (the remediation hint carries the UX fix).
// ---------------------------------------------------------------------------

const bodyReadsNowBlocked = [
  ["python3 -c json.load+open+print read of trust.bundle", `python3 -c "import json;print(json.load(open('.kontourai/flow-agents/slug/trust.bundle'))['claims'][0])"`],
  ["node -e readFileSync+console.log read of state.json", `node -e "console.log(JSON.parse(require('fs').readFileSync('.kontourai/flow-agents/slug/state.json','utf8')).status)"`],
  ["cd prefix + read-only python -c", `cd /repo && python3 -c "print(json.load(open('.kontourai/flow-agents/slug/trust.bundle')))"`],
];

for (const [label, cmd] of bodyReadsNowBlocked) {
  test(`v2 (body analysis removed, must block with hint): ${label}`, () => {
    const res = runBash(cmd);
    assert.equal(res.exitCode, 2, `expected BLOCK for: ${cmd}`);
    assert.match(res.stderr, /json\.tool/, "block message must name the sanctioned read idiom");
  });
}

// ---------------------------------------------------------------------------
// v2 verify finding 3 (end-to-end): json.tool's second positional operand is a write-capable
// OUTFILE. The grammar refuses to fast-pass it AND the hook must BLOCK it (the `-c`-only
// interpreter regex cannot see `-m` forms; isJsonToolWriteShape closes that fall-through).
// ---------------------------------------------------------------------------

test("json.tool outfile form targeting a protected path BLOCKS end-to-end", () => {
  const res = runBash("python3 -m json.tool in.json .kontourai/flow-agents/slug/trust.bundle");
  assert.equal(res.exitCode, 2, res.stderr);
  assert.match(res.stderr, /json\.tool/);
});

test("json.tool outfile form via stdin operand targeting a protected path BLOCKS end-to-end", () => {
  const res = runBash("python3 -m json.tool - delivery/trust.checkpoint.json");
  assert.equal(res.exitCode, 2, res.stderr);
});

test("json.tool outfile hidden behind the -- option terminator BLOCKS end-to-end (round-3 finding)", () => {
  const res = runBash("python3 -m json.tool -- -in.json delivery/trust.checkpoint.json");
  assert.equal(res.exitCode, 2, res.stderr);
});

test("json.tool with an unrecognized option-like token and a protected path BLOCKS end-to-end (fail closed)", () => {
  const res = runBash("python3 -m json.tool --mystery delivery/trust.checkpoint.json");
  assert.equal(res.exitCode, 2, res.stderr);
});

test("json.tool with a formatting option and a single input operand still ALLOWS end-to-end (read; not fast-passed, but not a write shape)", () => {
  const res = runBash("python3 -m json.tool --indent 2 .kontourai/flow-agents/slug/state.json");
  assert.equal(res.exitCode, 0, res.stderr);
});

test("blocked interpreter-write message names the read remediation (python3 -m json.tool)", () => {
  const res = runBash(`python3 -c "open('.kontourai/flow-agents/slug/state.json','w').write('{}')"`);
  assert.equal(res.exitCode, 2);
  assert.match(res.stderr, /python3 -m json\.tool/);
});

// ---------------------------------------------------------------------------
// Adversarial suite: every one of these MUST still BLOCK.
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
    "eval() escape hatch in a read-shaped body",
    `python3 -c "eval(open('.kontourai/flow-agents/slug/trust.bundle').read())"`,
  ],
  [
    "subprocess escape hatch in a read-shaped body",
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
    "unlisted mutator (os.truncate) in an otherwise read-shaped body -- the class that killed Grammar B",
    `python3 -c "import os,json;print(json.load(open('.kontourai/flow-agents/slug/trust.bundle')));os.truncate('.kontourai/flow-agents/slug/trust.bundle',0)"`,
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
// Direct grammar unit tests (lib/read-only-grammar.js) -- pins the grammar's own decision
// surface, including every misclassified-input class from the adversarial review.
// ---------------------------------------------------------------------------

test("isProvablyReadOnlyCommand: grammar unit matrix", () => {
  const deps = { tokenize: hook.tokenize, splitSegments: hook.splitSegments };
  const allow = [
    `python3 -m json.tool state.json`,
    `python -m json.tool state.json`,
    `python2 -m json.tool state.json`,
    `python3 -m json.tool .kontourai/flow-agents/slug/trust.bundle`,
    `cat state.json | python3 -m json.tool`,
    `cat delivery/x/trust.checkpoint.json | python -m json.tool`,
  ];
  const block = [
    ``,
    // v1 Grammar B shapes: body analysis is gone, none of these fast-pass anymore.
    `python3 -c "print(json.load(open('trust.bundle')))"`,
    `python3 -c "print(open('trust.bundle').read())"`,
    `node -e "console.log(require('fs').readFileSync('trust.bundle','utf8'))"`,
    `cd /tmp && python3 -c "print(json.load(open('trust.bundle')))"`,
    // Writes and escape hatches (unchanged expectations).
    `python3 -c "open('trust.bundle','w')"`,
    `python3 -c "json.dump({}, open('trust.bundle','w'))"`,
    `node -e "require('fs').writeFileSync('trust.bundle','x')"`,
    `sed -i 's/a/b/' trust.bundle`,
    `perl -e 'print 1' trust.bundle`,
    `python3 -c "print(1)" > trust.bundle`,
    `python3 -c "eval(open('trust.bundle').read())"`,
    `ls && python3 -c "print(json.load(open('trust.bundle')))"`,
    // Review HIGH: json.tool's write-capable positional OUTFILE and any option shape.
    `python3 -m json.tool in.json trust.bundle`,
    `python3 -m json.tool state.json extra.json more.json`,
    `python3 -m json.tool --indent 2 state.json`,
    `python3 -m json.tool -`,
    `python3 -m json.tool`,
    // Review HIGH: cat side must be exactly `cat <path>`.
    `cat -v state.json | python3 -m json.tool`,
    `cat a.json b.json | python3 -m json.tool`,
    `cat | python3 -m json.tool`,
    `cat - | python3 -m json.tool`,
    `tac state.json | python3 -m json.tool`,
    // Review HIGH: substitutions, expansions, quoting, and redirection forms -- all excluded
    // by the raw charset gate.
    "cat `x` | python3 -m json.tool",
    `cat $(touch pwned) | python3 -m json.tool`,
    `cat "state.json" | python3 -m json.tool`,
    `python3 -m json.tool 'state.json'`,
    `python3 -m json.tool $FILE`,
    `python3 -m json.tool state.json > trust.bundle`,
    `python3 -m json.tool state.json 2>err`,
    `python3 -m json.tool <(sh evil)`,
    `python3 -m json.tool state.json < in`,
    `python3 -m json.tool state.json & rm x`,
    `python3 -m json.tool state.json; rm x`,
    `python3 -m json.tool state.json\nrm x`,
    `python3 -m json.tool state\\.json`,
    `python3 -m json.tool ~/state.json`,
    `python3 -m json.tool *.json`,
    // Pipe structure: only exactly `cat <path> | <py> -m json.tool`.
    `cat state.json | python3 -m json.tool | cat`,
    `cat state.json | tee x | python3 -m json.tool`,
    `cat state.json |`,
    `| python3 -m json.tool`,
    `cat state.json || python3 -m json.tool`,
    `cat state.json | python3 -m json.tool state.json | cat state.json`,
    // cd prefixes are no longer recognized (separators other than `|` are out of the alphabet).
    `cd /tmp && python3 -m json.tool state.json`,
    // Length cap.
    `python3 -m json.tool ${"a/".repeat(300)}state.json`,
    // Boundary characters outside the charset: tab, CRLF, non-ASCII whitespace.
    `python3 -m json.tool\tstate.json`,
    `python3 -m json.tool state.json\r`,
    `python3 -m json.tool state.json`,
  ];
  // Non-string inputs fail closed.
  for (const bad of [null, undefined, 42, {}, ["cat x | python3 -m json.tool"]]) {
    assert.equal(isProvablyReadOnlyCommand(bad, deps), false, `expected false for non-string input: ${String(bad)}`);
  }
  for (const cmd of allow) {
    assert.equal(isProvablyReadOnlyCommand(cmd, deps), true, `expected ALLOW: ${cmd}`);
    // The grammar is self-contained under the charset gate: deps are accepted for call-site
    // compatibility but not required for a correct decision.
    assert.equal(isProvablyReadOnlyCommand(cmd), true, `expected ALLOW without deps: ${cmd}`);
  }
  for (const cmd of block) {
    assert.equal(isProvablyReadOnlyCommand(cmd, deps), false, `expected fall-through (not fast-passed): ${cmd}`);
  }
});
