// #783: the fixture affordance and the config-protection hook's declared-root scoping are two
// halves of one contract — fixtures are writable OUTSIDE declared artifact roots and nowhere
// else, through the CLI and past the hook alike. These tests pin both halves plus the
// fail-closed seam between them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const sidecarCli = path.join(packageRoot, "build", "src", "cli", "workflow-sidecar.js");
const require_ = createRequire(import.meta.url);
const hook = require_(path.join(packageRoot, "scripts", "hooks", "config-protection.js"));

const VALID_STATE = {
  schema_version: "1.0",
  task_slug: "fixture-spec",
  status: "in_progress",
  phase: "execution",
  created_at: "2026-07-20T19:00:00Z",
  updated_at: "2026-07-20T19:00:00Z",
  next_action: { status: "continue", summary: "Continue." },
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fa-783-"));
}

function runFixture(args, cwd) {
  return execFileSync(process.execPath, [sidecarCli, "fixture", ...args], {
    cwd,
    encoding: "utf8",
  });
}

// --- fixture write: sanctioned path ---

test("fixture write --from-json writes a schema-valid state.json outside declared roots", () => {
  const scratch = tmpdir();
  const input = path.join(scratch, "input.json");
  fs.writeFileSync(input, JSON.stringify(VALID_STATE));
  const target = path.join(scratch, "workspace", ".kontourai", "flow-agents", "fixture-spec");
  const out = runFixture(["write", target, "--from-json", input], scratch);
  assert.match(out, /schema-valid/);
  const written = JSON.parse(fs.readFileSync(path.join(target, "state.json"), "utf8"));
  assert.equal(written.task_slug, "fixture-spec");
});

test("fixture write --from-json refuses schema-invalid content and names the escape hatch", () => {
  const scratch = tmpdir();
  const input = path.join(scratch, "input.json");
  fs.writeFileSync(input, JSON.stringify({ schema_version: "1.0", task_slug: "x", status: "not-a-status" }));
  assert.throws(
    () => runFixture(["write", path.join(scratch, "t"), "--from-json", input], scratch),
    /does not satisfy workflow-state\.schema\.json[\s\S]*--malformed/,
  );
});

test("fixture write --malformed writes verbatim garbage outside declared roots", () => {
  const scratch = tmpdir();
  const target = path.join(scratch, "neg");
  runFixture(["write", target, "--malformed", "--content", "{not json at all"], scratch);
  assert.equal(fs.readFileSync(path.join(target, "state.json"), "utf8"), "{not json at all");
});

test("fixture write refuses a target inside the repo's declared artifact root, malformed or not", () => {
  const insideRepo = path.join(packageRoot, ".kontourai", "flow-agents", "forged-by-test");
  for (const args of [
    ["write", insideRepo, "--malformed", "--content", "x"],
    ["write", insideRepo, "--from-json", "/dev/null"],
  ]) {
    assert.throws(
      () => runFixture(args, packageRoot),
      /refused[\s\S]*declared[\s\S]*root/i,
      `expected refusal for ${args.join(" ")}`,
    );
  }
  assert.equal(fs.existsSync(insideRepo), false, "nothing may be created inside the declared root");
});

test("fixture write refuses a configured workspace root via SA_PROTECTED_WORKSPACE_ROOTS", () => {
  const scratch = tmpdir();
  const workspace = path.join(scratch, "ws");
  const target = path.join(workspace, ".kontourai", "flow-agents", "forged");
  assert.throws(() =>
    execFileSync(process.execPath, [sidecarCli, "fixture", "write", target, "--malformed", "--content", "x"], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, SA_PROTECTED_WORKSPACE_ROOTS: workspace },
    }),
  );
  assert.equal(fs.existsSync(target), false);
});

// --- hook scoping: blocks declared roots, allows scratch fixtures ---

test("hook still blocks redirects targeting the repo durable root (both spellings)", () => {
  for (const p of [".kontourai/flow-agents/slug/state.json", ".flow-agents/slug/state.json", "delivery/slug/trust.bundle"]) {
    const hit = hook.checkRedirectToProtected(`echo x > ${p}`, packageRoot);
    assert.ok(hit, `expected block for redirect to ${p}`);
  }
});

test("hook allows redirects into a temp dir outside every declared root (agent standing in a repo)", () => {
  // The legitimate #783 case: an agent working in a repo authors a fixture in a scratch dir.
  const scratch = tmpdir();
  const target = path.join(scratch, ".kontourai", "flow-agents", "demo", "state.json");
  assert.equal(hook.checkRedirectToProtected(`echo x > ${target}`, packageRoot), null);
  assert.equal(hook.checkRedirectToProtected(`cat y | tee ${target}`, packageRoot), null);
});

test("hook still protects the cwd's OWN workspace roots even without git (fail-closed cwd fallback)", () => {
  // Standing INSIDE a (possibly-real) workspace, its own .kontourai/flow-agents is a declared
  // root regardless of git presence — a non-git project workspace can hold real sidecars.
  const scratch = tmpdir();
  const target = path.join(scratch, ".kontourai", "flow-agents", "demo", "state.json");
  assert.ok(hook.checkRedirectToProtected(`echo x > ${target}`, scratch));
});

test("hook fails closed on bare basenames with no directory context (interpreter writes)", () => {
  // A bare `state.json` token in an interpreter one-liner cannot prove where a
  // runtime-constructed path lands, so it must remain blocked even from a scratch cwd.
  const scratch = tmpdir();
  const hit = hook.checkInterpreterWriteToProtected(
    `node -e "require('fs').writeFileSync('state.json','x')"`,
    scratch,
  );
  assert.ok(hit, "bare-basename interpreter write must stay blocked (fail-closed)");
});

// --- #783 security-review hardening (F1-F4) ---

test("F1 regression: shell profiles and .claude settings block globally, even from scratch cwd", () => {
  const scratch = tmpdir();
  assert.ok(hook.checkRedirectToProtected("echo x > ~/.bashrc", scratch));
  assert.ok(hook.checkRedirectToProtected("echo x > .claude/settings.json", scratch));
  const settingsToken = [".claude/", "settings.json"].join("");
  assert.ok(
    hook.checkInterpreterWriteToProtected(
      `node -e "require('fs').writeFileSync('${settingsToken}','x')"`,
      scratch,
    ),
  );
});

test("F2: bare $VAR expansion in an artifact-shaped target fails closed", () => {
  const scratch = tmpdir();
  assert.ok(hook.checkRedirectToProtected("echo x > $TARGET/.kontourai/flow-agents/s/state.json", scratch));
});

test("F2: an in-command cd removes root-scoping relief (fail closed)", () => {
  const outside = path.join(tmpdir(), ".kontourai", "flow-agents", "s", "state.json");
  // Without cd this exact target is allowed from packageRoot (proven above); with cd it blocks.
  assert.ok(hook.checkRedirectToProtected(`cd sub && echo x > ${outside}`, packageRoot));
});

test("F3: an artifact path inside ANY git working tree blocks, even a non-declared sibling checkout", () => {
  const sibling = tmpdir();
  fs.mkdirSync(path.join(sibling, ".git"), { recursive: true });
  const target = path.join(sibling, ".kontourai", "flow-agents", "s", "state.json");
  assert.ok(hook.checkRedirectToProtected(`echo x > ${target}`, packageRoot));
  assert.throws(
    () => runFixture(["write", path.dirname(target), "--malformed", "--content", "x"], packageRoot),
    /refused/,
  );
});

test("F4: a symlink routed into a declared root cannot launder a fixture write", () => {
  const scratch = tmpdir();
  const workspace = path.join(tmpdir(), "ws");
  const protectedDir = path.join(workspace, ".kontourai", "flow-agents");
  fs.mkdirSync(protectedDir, { recursive: true });
  const link = path.join(scratch, "innocent");
  fs.symlinkSync(protectedDir, link);
  assert.throws(() =>
    execFileSync(process.execPath, [sidecarCli, "fixture", "write", path.join(link, "forged"), "--malformed", "--content", "x"], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, SA_PROTECTED_WORKSPACE_ROOTS: workspace },
    }),
  );
  assert.equal(fs.existsSync(path.join(protectedDir, "forged")), false);
});

test("F4: symlink-aliased tmpdir spelling cannot bypass a declared workspace root", (t) => {
  const aliased = fs.mkdtempSync(path.join(os.tmpdir(), "alias-"));
  const canonical = fs.realpathSync(aliased);
  if (canonical === path.resolve(aliased)) {
    t.skip("tmpdir is not symlink-aliased on this platform");
    return;
  }
  const target = path.join(canonical, ".kontourai", "flow-agents", "s", "state.json");
  const origEnv = process.env.SA_PROTECTED_WORKSPACE_ROOTS;
  process.env.SA_PROTECTED_WORKSPACE_ROOTS = aliased; // declared with the ALIASED spelling
  try {
    assert.ok(hook.checkRedirectToProtected(`echo x > ${target}`, packageRoot));
  } finally {
    if (origEnv === undefined) delete process.env.SA_PROTECTED_WORKSPACE_ROOTS;
    else process.env.SA_PROTECTED_WORKSPACE_ROOTS = origEnv;
  }
});

// --- confirmation-review variants ---

test("F1 variants: case-folded profiles and settings.local block", () => {
  const scratch = tmpdir();
  assert.ok(hook.checkRedirectToProtected("echo x > ~/.BASHRC", scratch));
  const localSettings = [".claude/", "settings.local.json"].join("");
  assert.ok(hook.checkRedirectToProtected(`echo x > ${localSettings}`, scratch));
  assert.ok(
    hook.checkInterpreterWriteToProtected(
      `node -e "require('fs').writeFileSync('${localSettings}','x')"`,
      scratch,
    ),
  );
});

test("F2 variant: quote-concatenated cd cannot dodge the directory-change guard", () => {
  const outside = path.join(tmpdir(), ".kontourai", "flow-agents", "s", "state.json");
  assert.ok(hook.checkRedirectToProtected(`c""d src && echo x > ${outside}`, packageRoot));
});

test("F3 variant: a git-file worktree marker 45 directories deep still blocks", () => {
  const base = tmpdir();
  fs.writeFileSync(path.join(base, ".git"), "gitdir: /nonexistent\n");
  const deep = path.join(base, ...Array.from({ length: 45 }, (_, i) => `d${i}`));
  fs.mkdirSync(deep, { recursive: true });
  const target = path.join(deep, ".kontourai", "flow-agents", "s", "state.json");
  assert.ok(hook.checkRedirectToProtected(`echo x > ${target}`, packageRoot));
  assert.throws(() => runFixture(["write", path.dirname(target), "--malformed", "--content", "x"], packageRoot));
});

test("F4 variant: a symlink hiding the artifact-root spelling from the token still blocks", () => {
  const scratch = tmpdir();
  const workspace = path.join(tmpdir(), "ws");
  const artifactRoot = path.join(workspace, ".kontourai", "flow-agents");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const hop = path.join(scratch, "hop");
  fs.symlinkSync(artifactRoot, hop);
  const laundered = path.join(hop, "slug", "state.json"); // spelling shows no .kontourai
  const origEnv = process.env.SA_PROTECTED_WORKSPACE_ROOTS;
  process.env.SA_PROTECTED_WORKSPACE_ROOTS = workspace;
  try {
    assert.ok(hook.checkRedirectToProtected(`echo x > ${laundered}`, scratch));
  } finally {
    if (origEnv === undefined) delete process.env.SA_PROTECTED_WORKSPACE_ROOTS;
    else process.env.SA_PROTECTED_WORKSPACE_ROOTS = origEnv;
  }
});

test("JS/TS twin parity over a shared case table", async () => {
  const tsLib = await import(path.join(packageRoot, "build", "src", "lib", "declared-artifact-roots.js"));
  const jsLib = require_(path.join(packageRoot, "scripts", "hooks", "lib", "declared-artifact-roots.js"));
  const scratch = tmpdir();
  const sibling = tmpdir();
  fs.mkdirSync(path.join(sibling, ".git"), { recursive: true });
  const cases = [
    path.join(scratch, "fixture", "state.json"),
    path.join(packageRoot, ".kontourai", "flow-agents", "s", "state.json"),
    path.join(sibling, ".kontourai", "flow-agents", "s", "state.json"),
  ];
  for (const candidate of cases) {
    const hookSaysWithin = jsLib.isCandidateWithinDeclaredRoots(candidate, packageRoot);
    const fixtureSaysOutside = tsLib.isProvablyOutsideDeclaredRoots(candidate, packageRoot);
    assert.equal(
      hookSaysWithin,
      !fixtureSaysOutside,
      `twin divergence for ${candidate}: hook within=${hookSaysWithin}, fixture outside=${fixtureSaysOutside}`,
    );
  }
});

test("hook block message names the fixture affordance", () => {
  const result = hook.run(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `echo x > ${path.join(packageRoot, ".kontourai", "flow-agents", "s", "state.json")}` },
      cwd: packageRoot,
    }),
    {},
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /fixture write/);
});
