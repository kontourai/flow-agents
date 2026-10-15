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

const OLD_VERITAS = "npm exec -- veritas hooks codex pre-tool-use";
const NEW_VERITAS = "npx --no @kontourai/veritas hooks codex pre-tool-use";

function hookKit(id, target, host, command, extra = {}) {
  const kit = fixture([{ ...entry("governance", "hook.json", target), id: `${id}.governance`, host, kind: "hook", merge: "hooks-json" }]);
  const manifest = JSON.parse(fs.readFileSync(path.join(kit, "kit.json"), "utf8"));
  fs.writeFileSync(path.join(kit, "kit.json"), JSON.stringify({ ...manifest, id }));
  setHookCommand(kit, command, extra);
  return kit;
}

function setHookCommand(kit, command, extra = {}) {
  fs.writeFileSync(path.join(kit, "payload", "hook.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command, timeout: 30, ...extra }] }],
  } }, null, 2));
}

const commandsOf = (config, event = "PreToolUse") => (config.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));

for (const [host, target] of [["codex", ".codex/hooks.json"], ["claude-code", ".claude/settings.json"]]) {
  test(`hooks-json re-provisioning replaces the kit's earlier ${host} handler and keeps other handlers`, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-replace-"));
    fs.mkdirSync(path.join(repo, path.dirname(target)));
    fs.writeFileSync(path.join(repo, target), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-hook" }] }],
    } }));
    const other = hookKit("other", target, host, "other-kit-hook");
    await provisionKit(other, repo);
    const kit = hookKit("fixture", target, host, OLD_VERITAS);
    await provisionKit(kit, repo);
    assert.deepEqual(commandsOf(JSON.parse(fs.readFileSync(path.join(repo, target), "utf8"))), ["user-hook", "other-kit-hook", OLD_VERITAS]);

    setHookCommand(kit, NEW_VERITAS);
    const second = await provisionKit(kit, repo);
    const config = JSON.parse(fs.readFileSync(path.join(repo, target), "utf8"));
    assert.deepEqual(commandsOf(config), ["user-hook", "other-kit-hook", NEW_VERITAS]);
    assert.deepEqual(config.permissions, { allow: ["Bash(ls)"] });
    const manifest = JSON.parse(fs.readFileSync(second.manifest_path, "utf8"));
    assert.deepEqual(manifest.hook_handlers, [{
      id: "fixture.governance",
      target,
      event: "PreToolUse",
      command: NEW_VERITAS,
      group: { matcher: "apply_patch" },
      handler: { type: "command", command: NEW_VERITAS, timeout: 30 },
    }]);

    // The same command with changed settings replaces the kit's handler too,
    // rather than conflicting with it.
    setHookCommand(kit, NEW_VERITAS, { timeout: 60 });
    await provisionKit(kit, repo);
    const third = JSON.parse(fs.readFileSync(path.join(repo, target), "utf8"));
    assert.deepEqual(commandsOf(third), ["user-hook", "other-kit-hook", NEW_VERITAS]);
    assert.equal(third.hooks.PreToolUse.at(-1).hooks[0].timeout, 60);

    // The other kit's re-provisioning likewise leaves this kit's handler alone.
    setHookCommand(other, "other-kit-hook-v2");
    await provisionKit(other, repo);
    assert.deepEqual(commandsOf(JSON.parse(fs.readFileSync(path.join(repo, target), "utf8"))), ["user-hook", NEW_VERITAS, "other-kit-hook-v2"]);
  });
}

test("hooks-json re-provisioning drops an event the kit no longer declares and keeps a user handler in a shared group", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-event-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", OLD_VERITAS);
  fs.writeFileSync(path.join(kit, "payload", "hook.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: OLD_VERITAS }] }],
    Stop: [{ hooks: [{ type: "command", command: "kit-stop" }] }],
  } }));
  await provisionKit(kit, target);
  // A user adds their own handler to the kit's group.
  const installed = JSON.parse(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"));
  installed.hooks.PreToolUse[0].hooks.push({ type: "command", command: "user-in-kit-group" });
  fs.writeFileSync(path.join(target, ".codex/hooks.json"), JSON.stringify(installed));

  setHookCommand(kit, NEW_VERITAS);
  await provisionKit(kit, target);
  const config = JSON.parse(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"));
  assert.deepEqual(commandsOf(config), ["user-in-kit-group", NEW_VERITAS]);
  assert.equal(config.hooks.PreToolUse[0].matcher, "apply_patch");
  assert.equal("Stop" in config.hooks, false);
});

test("hooks-json keeps the record of a hook target the kit stops declaring", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-dropped-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", OLD_VERITAS);
  await provisionKit(kit, target);
  const withHook = JSON.parse(fs.readFileSync(path.join(kit, "kit.json"), "utf8"));
  fs.writeFileSync(path.join(kit, "kit.json"), JSON.stringify({ ...withHook, provisions: [entry("ordinary", "two.txt", "docs/two.txt")] }));
  const dropped = await provisionKit(kit, target);
  assert.deepEqual(JSON.parse(fs.readFileSync(dropped.manifest_path, "utf8")).hook_handlers.map((handler) => handler.command), [OLD_VERITAS]);
  assert.deepEqual(commandsOf(JSON.parse(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"))), [OLD_VERITAS]);

  fs.writeFileSync(path.join(kit, "kit.json"), JSON.stringify(withHook));
  setHookCommand(kit, NEW_VERITAS);
  await provisionKit(kit, target);
  assert.deepEqual(commandsOf(JSON.parse(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"))), [NEW_VERITAS]);
});

test("hooks-json never claims an identical handler a user wrote before the kit", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-user-first-"));
  fs.mkdirSync(path.join(target, ".codex"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", OLD_VERITAS);
  fs.copyFileSync(path.join(kit, "payload", "hook.json"), path.join(target, ".codex/hooks.json"));
  const first = await provisionKit(kit, target);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.manifest_path, "utf8")).hook_handlers, []);

  setHookCommand(kit, NEW_VERITAS);
  await provisionKit(kit, target);
  assert.deepEqual(commandsOf(JSON.parse(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"))), [OLD_VERITAS, NEW_VERITAS]);
});

test("hooks-json adopts the kit's identical handler from a manifest written before handler provenance", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-legacy-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", OLD_VERITAS);
  const first = await provisionKit(kit, target);
  const legacy = JSON.parse(fs.readFileSync(first.manifest_path, "utf8"));
  delete legacy.hook_handlers;
  fs.writeFileSync(first.manifest_path, JSON.stringify(legacy));

  const adopted = await provisionKit(kit, target);
  assert.deepEqual(JSON.parse(fs.readFileSync(adopted.manifest_path, "utf8")).hook_handlers.map((handler) => handler.command), [OLD_VERITAS]);
  setHookCommand(kit, NEW_VERITAS);
  await provisionKit(kit, target);
  assert.deepEqual(commandsOf(JSON.parse(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"))), [NEW_VERITAS]);
});

test("hooks-json refuses to guess ownership from an unreadable provision manifest before any write", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-bad-manifest-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", OLD_VERITAS);
  const first = await provisionKit(kit, target);
  const before = fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8");
  for (const [content, pattern] of [
    ["{broken", /provision manifest for kit 'fixture' is unreadable/],
    [JSON.stringify({ kit_id: "fixture", hook_handlers: [{ target: ".codex/hooks.json", event: "PreToolUse" }] }), /malformed hook_handlers/],
    // A hand-written record without the handler's identity cannot claim a handler.
    [JSON.stringify({ kit_id: "fixture", hook_handlers: [{ id: "fixture.governance", target: ".codex/hooks.json", event: "PreToolUse", command: OLD_VERITAS }] }), /malformed hook_handlers/],
    [JSON.stringify({ kit_id: "fixture", hook_handlers: null }), /malformed hook_handlers/],
    [JSON.stringify({ kit_id: "someone-else", hook_handlers: [] }), /does not describe kit 'fixture'/],
  ]) {
    fs.writeFileSync(first.manifest_path, content);
    setHookCommand(kit, NEW_VERITAS);
    await assert.rejects(() => provisionKit(kit, target), pattern);
    assert.equal(fs.readFileSync(path.join(target, ".codex/hooks.json"), "utf8"), before);
  }
});

test("hooks-json refuses another kit's malformed or misnamed manifest before writing", async () => {
  const repo = makeFixtureDir("kit-hook-other-manifest-");
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", "v1");
  const installed = await provisionKit(kit, repo);
  const hooksPath = path.join(repo, ".codex/hooks.json");
  const beforeHooks = fs.readFileSync(hooksPath, "utf8");
  const beforeManifest = fs.readFileSync(installed.manifest_path, "utf8");
  const otherPath = path.join(path.dirname(installed.manifest_path), "other.json");
  setHookCommand(kit, "v2");
  for (const [content, pattern] of [
    ["{broken", /is unreadable/],
    [JSON.stringify({ kit_id: "different-name", hook_handlers: [] }), /does not describe kit 'other'/],
    [JSON.stringify({ kit_id: "other", hook_handlers: [{ target: ".codex/hooks.json", event: "PreToolUse", command: "v1" }] }), /malformed hook_handlers/],
  ]) {
    fs.writeFileSync(otherPath, content);
    await assert.rejects(() => provisionKit(kit, repo), pattern);
    assert.equal(fs.readFileSync(hooksPath, "utf8"), beforeHooks);
    assert.equal(fs.readFileSync(installed.manifest_path, "utf8"), beforeManifest);
  }
});

const readHooks = (repo, target = ".codex/hooks.json") => JSON.parse(fs.readFileSync(path.join(repo, target), "utf8"));
const matcherCommands = (config, event = "PreToolUse") => (config.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => `${group.matcher}:${hook.command}`));

function stripHookProvenance(manifestPath) {
  const legacy = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete legacy.hook_handlers;
  delete legacy.superseded_handlers;
  fs.writeFileSync(manifestPath, JSON.stringify(legacy));
}

function declareSupersedes(kit, supersedes) {
  const manifest = JSON.parse(fs.readFileSync(path.join(kit, "kit.json"), "utf8"));
  manifest.provisions[0].supersedes = supersedes;
  fs.writeFileSync(path.join(kit, "kit.json"), JSON.stringify(manifest));
}

test("hooks-json keeps a group two kits declare identically when one of them upgrades", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-shared-"));
  const first = hookKit("ka", ".codex/hooks.json", "codex", "shared-cmd");
  const second = hookKit("kb", ".codex/hooks.json", "codex", "shared-cmd");
  await provisionKit(first, repo);
  const shared = await provisionKit(second, repo);
  assert.deepEqual(JSON.parse(fs.readFileSync(shared.manifest_path, "utf8")).hook_handlers.map((handler) => handler.command), ["shared-cmd"]);
  setHookCommand(first, "a-v2");
  await provisionKit(first, repo);
  assert.deepEqual(matcherCommands(readHooks(repo)), ["apply_patch:shared-cmd", "apply_patch:a-v2"]);
  // Once no other kit records it, the remaining owner replaces it.
  setHookCommand(second, "b-v2");
  await provisionKit(second, repo);
  assert.deepEqual(matcherCommands(readHooks(repo)), ["apply_patch:a-v2", "apply_patch:b-v2"]);
});

test("hooks-json keeps a group two legacy kits both adopt when one of them upgrades", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-shared-legacy-"));
  const first = hookKit("ka", ".codex/hooks.json", "codex", "shared-cmd");
  const second = hookKit("kb", ".codex/hooks.json", "codex", "shared-cmd");
  const firstRun = await provisionKit(first, repo);
  const secondRun = await provisionKit(second, repo);
  stripHookProvenance(firstRun.manifest_path);
  stripHookProvenance(secondRun.manifest_path);
  await provisionKit(first, repo);
  await provisionKit(second, repo);
  setHookCommand(second, "b-v2");
  await provisionKit(second, repo);
  assert.deepEqual(matcherCommands(readHooks(repo)), ["apply_patch:shared-cmd", "apply_patch:b-v2"]);
});

test("hooks-json leaves user handlers that reuse the kit's command with other matchers or settings", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-user-copy-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", OLD_VERITAS);
  await provisionKit(kit, repo);
  const config = readHooks(repo);
  config.hooks.PreToolUse.push(
    { matcher: "Bash", hooks: [{ type: "command", command: OLD_VERITAS }] },
    { matcher: "apply_patch", hooks: [{ type: "command", command: OLD_VERITAS, timeout: 90 }] },
  );
  fs.writeFileSync(path.join(repo, ".codex/hooks.json"), JSON.stringify(config));
  setHookCommand(kit, NEW_VERITAS);
  await provisionKit(kit, repo);
  const after = readHooks(repo);
  assert.deepEqual(matcherCommands(after), [`Bash:${OLD_VERITAS}`, `apply_patch:${OLD_VERITAS}`, `apply_patch:${NEW_VERITAS}`]);
  assert.equal(after.hooks.PreToolUse[1].hooks[0].timeout, 90);
});

for (const [legacy, boundary, supersedes] of [[false, "after", false], [true, "before", false], [true, "before", true]]) {
  test(`hooks-json recovers ${legacy ? (supersedes ? "legacy superseded" : "legacy") : "recorded"} ownership after a crash ${boundary} the hook rename`, async () => {
    const repo = makeFixtureDir("kit-hook-crash-");
    const kit = hookKit("fixture", ".codex/hooks.json", "codex", "v1");
    const first = await provisionKit(kit, repo);
    if (legacy) stripHookProvenance(first.manifest_path);
    setHookCommand(kit, legacy && !supersedes ? "v1" : "v2", { timeout: 60 });
    if (supersedes) declareSupersedes(kit, ["v1"]);
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const [modulePath, kit, repo, boundary] = process.argv.slice(1);
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        const hooks = destination === path.join(fs.realpathSync(repo), ".codex/hooks.json");
        if (hooks && boundary === "before") process.kill(process.pid, "SIGKILL");
        rename(source, destination);
        if (hooks && boundary === "after") process.kill(process.pid, "SIGKILL");
      };
      syncBuiltinESMExports();
      const { provisionKit } = await import(modulePath);
      await provisionKit(kit, repo);
    `, new URL("../../build/src/flow-kit/provision.js", import.meta.url).href, kit, repo, boundary], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.deepEqual(matcherCommands(readHooks(repo)), [legacy ? "apply_patch:v1" : "apply_patch:v2"]);
    const records = JSON.parse(fs.readFileSync(first.manifest_path, "utf8")).hook_handlers;
    if (supersedes) {
      assert.deepEqual(JSON.parse(fs.readFileSync(first.manifest_path, "utf8")).superseded_handlers, []);
      const manifest = JSON.parse(fs.readFileSync(path.join(kit, "kit.json"), "utf8"));
      delete manifest.provisions[0].supersedes;
      fs.writeFileSync(path.join(kit, "kit.json"), JSON.stringify(manifest));
    }
    setHookCommand(kit, "v3");
    await provisionKit(kit, repo);
    assert.deepEqual(matcherCommands(readHooks(repo)), ["apply_patch:v3"]);
    assert.deepEqual(records.map((handler) => handler.handler.timeout).sort((a, b) => a - b), [30, 60]);
  });
}

test("hooks-json supersedes migrates an install made before handler provenance", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-supersedes-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", OLD_VERITAS);
  const first = await provisionKit(kit, repo);
  stripHookProvenance(first.manifest_path);
  const config = readHooks(repo);
  config.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "user-hook" }] });
  config.hooks.PostToolUse = [{ matcher: "apply_patch", hooks: [{ type: "command", command: OLD_VERITAS }] }];
  fs.writeFileSync(path.join(repo, ".codex/hooks.json"), JSON.stringify(config));

  setHookCommand(kit, NEW_VERITAS);
  declareSupersedes(kit, [OLD_VERITAS]);
  const migrated = await provisionKit(kit, repo);
  const after = readHooks(repo);
  assert.deepEqual(matcherCommands(after), ["Bash:user-hook", `apply_patch:${NEW_VERITAS}`]);
  // Supersedes reaches only the events the provision declares.
  assert.deepEqual(matcherCommands(after, "PostToolUse"), [`apply_patch:${OLD_VERITAS}`]);
  assert.deepEqual(JSON.parse(fs.readFileSync(migrated.manifest_path, "utf8")).superseded_handlers, [
    { id: "fixture.governance", target: ".codex/hooks.json", event: "PreToolUse", command: OLD_VERITAS },
  ]);
});

test("hooks-json supersedes never removes a command another kit records", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-supersedes-other-"));
  const other = hookKit("other", ".codex/hooks.json", "codex", OLD_VERITAS);
  await provisionKit(other, repo);
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", NEW_VERITAS);
  declareSupersedes(kit, [OLD_VERITAS]);
  await provisionKit(kit, repo);
  assert.deepEqual(matcherCommands(readHooks(repo)), [`apply_patch:${OLD_VERITAS}`, `apply_patch:${NEW_VERITAS}`]);
});

test("hooks-json supersedes refuses a command the provision still declares", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-supersedes-self-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", NEW_VERITAS);
  declareSupersedes(kit, [NEW_VERITAS]);
  await assert.rejects(() => provisionKit(kit, repo), /supersedes a command it still declares/);
  assert.equal(fs.existsSync(path.join(repo, ".codex/hooks.json")), false);
});

test("provision validation bounds supersedes", async () => {
  const hook = { ...entry("governance", "hook.json", ".codex/hooks.json"), host: "codex", kind: "hook", merge: "hooks-json" };
  const cases = [
    [[{ ...entry("one", "one.txt", "docs/one.txt"), supersedes: ["x"] }], /supersedes requires merge: hooks-json/],
    [[{ ...hook, supersedes: [] }], /supersedes must be 1-32 unique non-blank command strings/],
    [[{ ...hook, supersedes: ["x", "x"] }], /supersedes must be 1-32/],
    [[{ ...hook, supersedes: [" "] }], /supersedes must be 1-32/],
    [[{ ...hook, supersedes: Array.from({ length: 33 }, (_, index) => `old-${index}`) }], /supersedes must be 1-32/],
    [[{ ...hook, supersedes: ["x".repeat(4097)] }], /at most 4096 characters/],
  ];
  for (const [provisions, pattern] of cases) {
    const errors = await validateKitRepository(fixture(provisions));
    assert.ok(errors.some((error) => pattern.test(error)), `${pattern}: ${errors.join("; ")}`);
  }
  for (const supersedes of [["x"], Array.from({ length: 32 }, (_, index) => `old-${index}`), ["x".repeat(4096)]]) {
    assert.deepEqual(await validateKitRepository(fixture([{ ...hook, supersedes }])), [], `accepted at the bound: ${supersedes.length}`);
  }
});

test("hooks-json legacy adoption replaces the kit's handler when only its settings changed", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-legacy-timeout-"));
  const kit = hookKit("fixture", ".codex/hooks.json", "codex", NEW_VERITAS);
  const first = await provisionKit(kit, repo);
  stripHookProvenance(first.manifest_path);
  setHookCommand(kit, NEW_VERITAS, { timeout: 60 });
  await provisionKit(kit, repo);
  const after = readHooks(repo);
  assert.deepEqual(matcherCommands(after), [`apply_patch:${NEW_VERITAS}`]);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].timeout, 60);
});

test("hooks-json merges into a Claude settings file that has no hooks yet", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-hook-claude-empty-"));
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify({ permissions: { allow: [] } }));
  const kit = hookKit("fixture", ".claude/settings.json", "claude-code", "c1");
  await provisionKit(kit, repo);
  const settings = readHooks(repo, ".claude/settings.json");
  assert.deepEqual(settings.permissions, { allow: [] });
  assert.deepEqual(matcherCommands(settings), ["apply_patch:c1"]);
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
