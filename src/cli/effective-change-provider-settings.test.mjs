import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "build", "src", "cli.js");
const fixtures = path.join(root, "evals", "fixtures", "change-provider-settings");
const absent = path.join(root, "evals", "fixtures", "change-provider-settings", "absent.json");

function run(projectSettings) {
  return spawnSync(process.execPath, [cli, "effective-change-provider-settings", "--repo-path", root, "--project-settings", projectSettings, "--global-settings", absent, "--json"], { encoding: "utf8" });
}

test("effective ChangeProvider settings report configured, absent, malformed, and secret-bearing inputs without fallback", () => {
  const configured = run(path.join(fixtures, "configured.json"));
  assert.equal(configured.status, 0, configured.stderr);
  const configuredJson = JSON.parse(configured.stdout);
  assert.equal(configuredJson.status, "configured");
  assert.deepEqual(configuredJson.provider.capabilities, ["change.create", "change.observe"]);
  assert.equal(Object.hasOwn(configuredJson.provider, "token"), false);

  const unavailable = run(absent);
  assert.equal(unavailable.status, 2, unavailable.stderr);
  assert.equal(JSON.parse(unavailable.stdout).status, "unconfigured");

  const malformed = run(path.join(fixtures, "malformed.json"));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /unsupported schema_version/);

  const hostile = run(path.join(fixtures, "hostile-secret.json"));
  assert.equal(hostile.status, 2, hostile.stderr);
  const hostileJson = JSON.parse(hostile.stdout);
  assert.equal(hostileJson.status, "unsupported");
  assert.match(hostileJson.reason, /change_provider/);
  assert.equal(hostile.stdout.includes("must-not-be-persisted"), false);
});

test("effective ChangeProvider settings default to the consumer repository context path", () => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-change-provider-consumer-"));
  try {
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ repository: "https://github.com/consumer/example.git" }));
    const settings = path.join(consumer, "context", "settings", "change-provider-settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({
      schema_version: "1.0",
      defaults: { provider: { role: "ChangeProvider", kind: "github", repository: { owner: "consumer", name: "example" }, capabilities: ["change.create", "change.observe"], executor: "gh-cli" } },
    }));
    const result = spawnSync(process.execPath, [cli, "effective-change-provider-settings", "--repo-path", consumer, "--global-settings", absent, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, "configured");
    assert.equal(value.provider.repository.owner, "consumer");
    assert.equal(value.provider.repository.name, "example");
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
});

test("effective ChangeProvider settings do not trust ambient HOME or Git package metadata fallback", async () => {
  const hostileHome = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-hostile-home-"));
  const gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-provider-git-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = hostileHome;
    const module = await import(`../../build/src/cli/effective-change-provider-settings.js?authority=${Date.now()}`);
    assert.equal(module.trustedGlobalChangeProviderSettingsPath().startsWith(hostileHome), false);

    spawnSync("git", ["init", "-q"], { cwd: gitRepo });
    fs.writeFileSync(path.join(gitRepo, "package.json"), JSON.stringify({ repository: "https://github.com/attacker/redirect.git" }));
    const result = module.resolveEffectiveChangeProviderSettings(gitRepo, absent, absent);
    assert.equal(result.status, "unconfigured");
    assert.equal(result.reason, "could_not_identify_current_repo");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(hostileHome, { recursive: true, force: true });
    fs.rmSync(gitRepo, { recursive: true, force: true });
  }
});
