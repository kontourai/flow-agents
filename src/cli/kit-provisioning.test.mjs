import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { validateKitRepository } from "../../build/src/flow-kit/validate.js";
import { provisionKit, ProvisionConflictError } from "../../build/src/flow-kit/provision.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const FLOW = {
  id: "fixture.review",
  version: "1.0",
  steps: [{ id: "review", next: "done" }, { id: "done", next: null }],
  gates: {},
};

function fixture(provisions) {
  const dir = makeFixtureDir("kit-provision-unit-");
  fs.mkdirSync(path.join(dir, "flows"));
  fs.mkdirSync(path.join(dir, "payload"));
  fs.writeFileSync(path.join(dir, "flows", "review.flow.json"), JSON.stringify(FLOW));
  fs.writeFileSync(path.join(dir, "payload", "one.txt"), "one-new\n");
  fs.writeFileSync(path.join(dir, "payload", "two.txt"), "two-new\n");
  fs.writeFileSync(path.join(dir, "payload", "hook.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "npm exec -- veritas hooks codex pre-tool-use", timeout: 30 }] }],
  } }, null, 2));
  fs.writeFileSync(path.join(dir, "kit.json"), JSON.stringify({
    schema_version: "1.0",
    id: "fixture",
    name: "Fixture",
    flows: [{ id: "fixture.review", path: "flows/review.flow.json" }],
    provisions,
  }));
  return dir;
}

const entry = (id, source, target) => ({ id: `fixture.${id}`, path: `payload/${source}`, target });

test("host-bound provisions install through Conduit with content-safe receipts", async () => {
  const kit = fixture([
    { ...entry("codex", "one.txt", ".codex/hooks.json"), host: "codex", kind: "hook" },
    { ...entry("claude", "two.txt", ".claude/settings.json"), host: "claude-code", kind: "hook" },
  ]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-conduit-"));
  const result = await provisionKit(kit, target);
  assert.equal(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"), "one-new\n");
  assert.equal(fs.readFileSync(path.join(target, ".claude/settings.json"), "utf8"), "two-new\n");
  assert.deepEqual(result.conduit_receipts?.map((receipt) => receipt.hostId), ["codex", "claude-code"]);
  for (const receipt of result.conduit_receipts ?? []) {
    assert.equal(receipt.installed[0]?.kind, "hook");
    assert.match(receipt.installed[0]?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(receipt), /one-new|two-new|\.codex\/hooks|\.claude\/settings/);
  }
  const manifest = JSON.parse(fs.readFileSync(result.manifest_path, "utf8"));
  assert.deepEqual(manifest.conduit_receipts, result.conduit_receipts);
});

test("host-bound provisions refuse unsupported asset kinds before any write", async () => {
  const kit = fixture([
    { ...entry("unsupported", "one.txt", ".codex/agent.json"), host: "codex", kind: "agent" },
    entry("ordinary", "two.txt", "docs/two.txt"),
  ]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-unsupported-"));
  await assert.rejects(() => provisionKit(kit, target), /Conduit host codex cannot install agent/);
  assert.equal(fs.existsSync(path.join(target, ".codex/agent.json")), false);
  assert.equal(fs.existsSync(path.join(target, "docs/two.txt")), false);
});

test("host-bound provisions reject oversized content before writing", async () => {
  const kit = fixture([{ ...entry("oversized", "one.txt", ".codex/hooks.json"), host: "codex", kind: "hook" }]);
  fs.writeFileSync(path.join(kit, "payload/one.txt"), "x".repeat(1_000_001));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-oversized-"));
  await assert.rejects(() => provisionKit(kit, target), /Conduit host asset exceeds 1000000 bytes/);
  assert.equal(fs.existsSync(path.join(target, ".codex/hooks.json")), false);
});

test("host and asset kind must be declared together", async () => {
  const kit = fixture([{ ...entry("incomplete", "one.txt", ".codex/hooks.json"), host: "codex" }]);
  const errors = await validateKitRepository(kit);
  assert.ok(errors.some((error) => error.includes("host and kind must be declared together")));
});

test("hooks-json refuses conflicting commands before writing another provision", async () => {
  const kit = fixture([
    { ...entry("governance", "hook.json", ".codex/hooks.json"), host: "codex", kind: "hook", merge: "hooks-json" },
    entry("ordinary", "two.txt", "docs/two.txt"),
  ]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-conflict-"));
  fs.mkdirSync(path.join(target, ".codex"));
  const previous = JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "npm exec -- veritas hooks codex pre-tool-use", timeout: 1 }] }],
  } });
  fs.writeFileSync(path.join(target, ".codex/hooks.json"), previous);
  await assert.rejects(() => provisionKit(kit, target), /hooks-json merge conflicts with an existing command/);
  assert.equal(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"), previous);
  assert.equal(fs.existsSync(path.join(target, "docs/two.txt")), false);
});

test("hooks-json refuses malformed existing host configuration before any write", async () => {
  const kit = fixture([
    { ...entry("governance", "hook.json", ".codex/hooks.json"), host: "codex", kind: "hook", merge: "hooks-json" },
    entry("ordinary", "two.txt", "docs/two.txt"),
  ]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-malformed-"));
  fs.mkdirSync(path.join(target, ".codex"));
  fs.writeFileSync(path.join(target, ".codex/hooks.json"), "{broken");
  await assert.rejects(() => provisionKit(kit, target), /hooks-json merge requires valid JSON/);
  assert.equal(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"), "{broken");
  assert.equal(fs.existsSync(path.join(target, "docs/two.txt")), false);
});

test("hooks-json adds a host handler once while preserving existing handlers", async () => {
  const kit = fixture([{ ...entry("governance", "hook.json", ".codex/hooks.json"), host: "codex", kind: "hook", merge: "hooks-json" }]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-idempotent-"));
  fs.mkdirSync(path.join(target, ".codex"));
  fs.writeFileSync(path.join(target, ".codex/hooks.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "existing-hook" }] }],
  } }));
  const first = await provisionKit(kit, target);
  const firstBytes = fs.readFileSync(path.join(target, ".codex/hooks.json"));
  const second = await provisionKit(kit, target);
  const secondBytes = fs.readFileSync(path.join(target, ".codex/hooks.json"));
  assert.deepEqual(secondBytes, firstBytes);
  const commands = JSON.parse(secondBytes.toString("utf8")).hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.deepEqual(commands, ["existing-hook", "npm exec -- veritas hooks codex pre-tool-use"]);
  assert.equal(first.conduit_receipts[0].installed[0].digest, second.conduit_receipts[0].installed[0].digest);
});

test("provision validation rejects unsafe and duplicate normalized targets", async () => {
  const cases = [
    [[entry("one", "one.txt", "../escape.txt")], "traversal segments"],
    [[entry("one", "one.txt", path.resolve("/tmp/escape.txt"))], "must be relative"],
    [[entry("one", "one.txt", ".git/config")], "must not be inside .git"],
    [[entry("one", "one.txt", ".GIT/hooks/pre-push")], "must not be inside .git"],
    [[entry("one", "one.txt", "docs//same.txt"), entry("two", "two.txt", "docs/same.txt")], "target duplicates"],
    [[entry("one", "one.txt", "README.md"), entry("two", "two.txt", "readme.md")], "target duplicates"],
    [[entry("one", "one.txt", ".kontourai/flow-agents/provisions/fixture.json")], "provision manifest namespace"],
    [[{ id: "fixture.one", path: "payload/../payload/one.txt", target: "out.txt" }], "must not contain traversal segments"],
  ];
  for (const [provisions, message] of cases) {
    const errors = await validateKitRepository(fixture(provisions));
    assert.equal(errors.some((error) => error.includes(message)), true, errors.join("\n"));
  }
});

test("provision core preflights conflicts before writing and force overwrites", async () => {
  const kit = fixture([entry("one", "one.txt", "docs/one.txt"), entry("two", "two.txt", "docs/two.txt")]);
  const target = makeFixtureDir("kit-provision-target-");
  fs.mkdirSync(path.join(target, "docs"));
  fs.writeFileSync(path.join(target, "docs", "two.txt"), "keep\n");

  await assert.rejects(() => provisionKit(kit, target), (error) => error instanceof ProvisionConflictError && error.conflicts.length === 1);
  assert.equal(fs.existsSync(path.join(target, "docs", "one.txt")), false);
  assert.equal(fs.readFileSync(path.join(target, "docs", "two.txt"), "utf8"), "keep\n");

  const result = await provisionKit(kit, target, { force: true });
  assert.equal(fs.readFileSync(path.join(target, "docs", "one.txt"), "utf8"), "one-new\n");
  assert.equal(fs.readFileSync(path.join(target, "docs", "two.txt"), "utf8"), "two-new\n");
  const manifest = JSON.parse(fs.readFileSync(result.manifest_path, "utf8"));
  assert.equal(manifest.schema_version, "1.0");
  assert.equal(manifest.kit_id, "fixture");
  assert.match(manifest.kit_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(manifest.files, [{ id: "fixture.one", target: "docs/one.txt" }, { id: "fixture.two", target: "docs/two.txt" }]);
});

test("provision core dry-run writes neither files nor manifest", async () => {
  const kit = fixture([entry("one", "one.txt", "docs/one.txt")]);
  const target = makeFixtureDir("kit-provision-dry-");
  const result = await provisionKit(kit, target, { dryRun: true });
  assert.equal(result.dry_run, true);
  assert.equal(fs.existsSync(path.join(target, "docs", "one.txt")), false);
  assert.equal(fs.existsSync(path.join(target, ".kontourai")), false);
});

test("provision core rejects destination paths whose existing ancestor escapes through a symlink", async () => {
  const kit = fixture([entry("one", "one.txt", "linked/one.txt")]);
  const target = makeFixtureDir("kit-provision-link-target-");
  const outside = makeFixtureDir("kit-provision-link-outside-");
  fs.symlinkSync(outside, path.join(target, "linked"), "dir");
  await assert.rejects(() => provisionKit(kit, target), /escapes consumer repository/);
  assert.equal(fs.existsSync(path.join(outside, "one.txt")), false);
});

test("provision rejects a source that resolves outside the kit through a symlink", async () => {
  const kit = fixture([entry("host", "host.txt", "copied.txt")]);
  const outside = makeFixtureDir("kit-provision-src-outside-");
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "off-kit-secret\n");
  fs.symlinkSync(secret, path.join(kit, "payload", "host.txt"));

  const errors = await validateKitRepository(kit);
  assert.equal(errors.some((error) => error.includes("must not resolve outside the kit directory")), true, errors.join("\n"));

  const target = makeFixtureDir("kit-provision-src-target-");
  await assert.rejects(() => provisionKit(kit, target), /escapes the kit directory|validation failed/);
  assert.equal(fs.existsSync(path.join(target, "copied.txt")), false);
});

test("init activation provisions create-only and reports rerun conflicts without failing", () => {
  const kit = fixture([entry("one", "one.txt", "docs/one.txt")]);
  const target = makeFixtureDir("kit-provision-init-");
  const install = spawnSync(process.execPath, ["build/src/cli.js", "kit", "install", kit, "--dest", target], { encoding: "utf8" });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const args = ["build/src/cli.js", "init", "--runtime", "codex", "--dest", target, "--telemetry-sink", "local-files", "--activate-kit", "fixture", "--yes"];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(fs.readFileSync(path.join(target, "docs", "one.txt"), "utf8"), "one-new\n");

  fs.writeFileSync(path.join(target, "docs", "one.txt"), "consumer-owned\n");
  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(`${second.stdout}\n${second.stderr}`, /skipped existing provision 'docs\/one.txt'/);
  assert.equal(fs.readFileSync(path.join(target, "docs", "one.txt"), "utf8"), "consumer-owned\n");
});

test("Git-style kit install and Codex init publish a Conduit hook receipt", () => {
  const kit = fixture([{ ...entry("governance", "hook.json", ".codex/hooks.json"), host: "codex", kind: "hook", merge: "hooks-json" }]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-conduit-init-"));
  const install = spawnSync(process.execPath, ["build/src/cli.js", "kit", "install", kit, "--dest", target], { encoding: "utf8" });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const activate = spawnSync(process.execPath, ["build/src/cli.js", "init", "--runtime", "codex", "--dest", target, "--telemetry-sink", "local-files", "--activate-kit", "fixture", "--yes"], { encoding: "utf8" });
  assert.equal(activate.status, 0, `${activate.stdout}\n${activate.stderr}`);
  const firstBytes = fs.readFileSync(path.join(target, ".codex/hooks.json"));
  const firstConfig = JSON.parse(firstBytes.toString("utf8"));
  const commands = Object.values(firstConfig.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
  assert.equal(commands.filter((command) => command === "npm exec -- veritas hooks codex pre-tool-use").length, 1);
  assert.ok(commands.some((command) => command.includes("flow-agents")));
  const manifest = JSON.parse(fs.readFileSync(path.join(target, ".kontourai/flow-agents/provisions/fixture.json"), "utf8"));
  assert.equal(manifest.conduit_receipts[0].hostId, "codex");
  assert.equal(manifest.conduit_receipts[0].installed[0].kind, "hook");
  assert.equal(manifest.conduit_receipts[0].installed[0].digest, `sha256:${createHash("sha256").update(firstBytes).digest("hex")}`);
  assert.doesNotMatch(JSON.stringify(manifest.conduit_receipts), /veritas hooks|\.codex\/hooks/);
  const rerun = spawnSync(process.execPath, ["build/src/cli.js", "init", "--runtime", "codex", "--dest", target, "--telemetry-sink", "local-files", "--activate-kit", "fixture", "--yes"], { encoding: "utf8" });
  assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
  const afterBytes = fs.readFileSync(path.join(target, ".codex/hooks.json"));
  const afterConfig = JSON.parse(afterBytes.toString("utf8"));
  const afterCommands = Object.values(afterConfig.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
  assert.deepEqual([...afterCommands].sort(), [...commands].sort());
  assert.equal(afterCommands.filter((command) => command === "npm exec -- veritas hooks codex pre-tool-use").length, 1);
  const afterManifest = JSON.parse(fs.readFileSync(path.join(target, ".kontourai/flow-agents/provisions/fixture.json"), "utf8"));
  assert.equal(afterManifest.conduit_receipts[0].installed[0].digest, `sha256:${createHash("sha256").update(afterBytes).digest("hex")}`);
});
