import assert from "node:assert/strict";
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
