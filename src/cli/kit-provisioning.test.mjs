import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { validateKitRepository } from "../../build/src/flow-kit/validate.js";
import { provisionKit, ProvisionConflictError } from "../../build/src/flow-kit/provision.js";

const FLOW = {
  id: "fixture.review",
  version: "1.0",
  steps: [{ id: "review", next: "done" }, { id: "done", next: null }],
  gates: {},
};

function fixture(provisions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-unit-"));
  fs.mkdirSync(path.join(dir, "flows"));
  fs.mkdirSync(path.join(dir, "payload"));
  fs.writeFileSync(path.join(dir, "flows", "review.flow.json"), JSON.stringify(FLOW));
  fs.writeFileSync(path.join(dir, "payload", "one.txt"), "one-new\n");
  fs.writeFileSync(path.join(dir, "payload", "two.txt"), "two-new\n");
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
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-target-"));
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
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-dry-"));
  const result = await provisionKit(kit, target, { dryRun: true });
  assert.equal(result.dry_run, true);
  assert.equal(fs.existsSync(path.join(target, "docs", "one.txt")), false);
  assert.equal(fs.existsSync(path.join(target, ".kontourai")), false);
});

test("provision core rejects destination paths whose existing ancestor escapes through a symlink", async () => {
  const kit = fixture([entry("one", "one.txt", "linked/one.txt")]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-link-target-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-link-outside-"));
  fs.symlinkSync(outside, path.join(target, "linked"), "dir");
  await assert.rejects(() => provisionKit(kit, target), /escapes consumer repository/);
  assert.equal(fs.existsSync(path.join(outside, "one.txt")), false);
});

test("provision rejects a source that resolves outside the kit through a symlink", async () => {
  const kit = fixture([entry("host", "host.txt", "copied.txt")]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-src-outside-"));
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "off-kit-secret\n");
  fs.symlinkSync(secret, path.join(kit, "payload", "host.txt"));

  const errors = await validateKitRepository(kit);
  assert.equal(errors.some((error) => error.includes("must not resolve outside the kit directory")), true, errors.join("\n"));

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-src-target-"));
  await assert.rejects(() => provisionKit(kit, target), /escapes the kit directory|validation failed/);
  assert.equal(fs.existsSync(path.join(target, "copied.txt")), false);
});

test("init activation provisions create-only and reports rerun conflicts without failing", () => {
  const kit = fixture([entry("one", "one.txt", "docs/one.txt")]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "kit-provision-init-"));
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
