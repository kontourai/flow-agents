import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main as kitMain, setKitCliTestHooksForTests } from "../../build/src/cli/kit.js";
import { observeKitContentHash } from "../../build/src/flow-kit/content-hash.js";
import { activateCodexLocal } from "../../build/src/runtime-adapters.js";

const FIXTURE = path.resolve("evals/fixtures/flow-kit-repository/valid-local-kit");

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyFixture(destination) {
  fs.cpSync(FIXTURE, destination, { recursive: true });
}

test("local install records the completed copied tree hash when its source changes before copy", async () => {
  const root = tempRoot("flow-kit-install-toctou-");
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  copyFixture(source);
  const before = observeKitContentHash(source);
  assert.equal(before.state, "observed");
  setKitCliTestHooksForTests({
    beforeCopy() {
      fs.appendFileSync(path.join(source, "docs", "README.md"), "changed-before-copy\n");
    },
  });
  try {
    assert.equal(await kitMain(["install", source, "--dest", dest]), 0);
  } finally {
    setKitCliTestHooksForTests(undefined);
  }
  const target = path.join(dest, "kits", "local", "repositories", "example-kit");
  const completed = observeKitContentHash(target, { trustedRoot: dest });
  assert.equal(completed.state, "observed");
  assert.notEqual(completed.observed_hash, before.observed_hash);
  const registry = JSON.parse(fs.readFileSync(path.join(dest, "kits", "local", "installed-kits.json"), "utf8"));
  assert.equal(registry.kits[0].hash, completed.observed_hash);
});

test("activation copies a stable snapshot when installed bytes change after snapshotting", async () => {
  const root = tempRoot("flow-kit-activation-snapshot-");
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  copyFixture(source);
  assert.equal(await kitMain(["install", source, "--dest", dest]), 0);
  const installedReadme = path.join(dest, "kits", "local", "repositories", "example-kit", "docs", "README.md");
  const before = fs.readFileSync(installedReadme, "utf8");
  const result = activateCodexLocal(process.cwd(), dest, {
    testHooks: {
      afterLocalSnapshot() {
        fs.writeFileSync(installedReadme, "replacement after snapshot\n");
      },
    },
  });
  assert.deepEqual(result.errors, []);
  const projection = path.join(dest, ".kontourai", "flow-agents", "projections", "codex", "docs", "example-kit", "README.md");
  assert.equal(fs.readFileSync(projection, "utf8"), before);
});

test("install rolls back a replaced target when post-copy observation is unsafe", async () => {
  const root = tempRoot("flow-kit-install-rollback-");
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  copyFixture(source);
  assert.equal(await kitMain(["install", source, "--dest", dest]), 0);
  const registryPath = path.join(dest, "kits", "local", "installed-kits.json");
  const registryBefore = fs.readFileSync(registryPath, "utf8");
  const target = path.join(dest, "kits", "local", "repositories", "example-kit");
  fs.appendFileSync(path.join(source, "docs", "README.md"), "source update\n");
  setKitCliTestHooksForTests({
    afterCopy(_source, completedTarget) {
      fs.rmSync(completedTarget, { recursive: true, force: true });
      fs.symlinkSync(path.join(root, "outside"), completedTarget);
    },
  });
  try {
    assert.equal(await kitMain(["install", source, "--dest", dest, "--force"]), 1);
  } finally {
    setKitCliTestHooksForTests(undefined);
  }
  assert.equal(fs.readFileSync(registryPath, "utf8"), registryBefore);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(target, "docs", "README.md"), "utf8").includes("source update"), false);
});

test("activation warns for malformed registry entries instead of silently dropping them", () => {
  const root = tempRoot("flow-kit-malformed-registry-");
  const dest = path.join(root, "dest");
  fs.mkdirSync(path.join(dest, "kits", "local"), { recursive: true });
  fs.writeFileSync(path.join(dest, "kits", "local", "installed-kits.json"), JSON.stringify({ schema_version: "1.0", kits: [null, { id: 7 }] }));
  const result = activateCodexLocal(process.cwd(), dest);
  assert.match(result.warnings.join("\n"), /entry 0 is invalid: entry must be an object/);
  assert.match(result.warnings.join("\n"), /entry 1 is invalid: id must be a string/);
});
