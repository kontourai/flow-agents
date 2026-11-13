import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Veritas's static evidence route includes source validation and the unit corpus once", () => {
  const map = JSON.parse(fs.readFileSync(path.join(root, ".veritas/repo-map.json"), "utf8"));
  const required = map.evidence.evidenceChecks.find((check) => check.id === "required-evidence-check");
  assert.equal(required.command, "npm run eval:static");
  const script = fs.readFileSync(path.join(root, "evals/run.sh"), "utf8");
  assert.match(script, /run_static\(\)[\s\S]*test_validate_source_kit_asset_scope\.sh/);
  assert.match(script, /run_static\(\)[\s\S]*test_unit_helpers\.sh/);
  const sourceProbe = fs.readFileSync(path.join(root, "evals/static/test_validate_source_kit_asset_scope.sh"), "utf8");
  const unitProbe = fs.readFileSync(path.join(root, "evals/static/test_unit_helpers.sh"), "utf8");
  assert.match(sourceProbe, /npm run validate:source/);
  assert.match(unitProbe, /node --test --test-concurrency=4 --import \.\/src\/cli\/unit-test-state\.mjs src\/cli\/\*\.test\.mjs/);
  assert.equal([...unitProbe.matchAll(/src\/cli\/\*\.test\.mjs/g)].length, 1, "the static route runs the whole unit corpus once with its runtime-state preload");
});

test("the CI registry requires the installed readiness route and all refusal controls", () => {
  const result = spawnSync("bash", [path.join(root, "evals/static/test_ci_check_registration.sh")], {
    cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: .*checks registered/);
});

function metadataFixture() {
  const dir = makeFixtureDir("readiness-source-");
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", head);
  const installed = path.join(dir, "node_modules/@kontourai/veritas/package.json");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "@kontourai/veritas": "1.12.2" } }));
  fs.writeFileSync(installed, JSON.stringify({ version: "1.12.2" }));
  const event = path.join(dir, "event.json");
  fs.writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: "b".repeat(40) } } }));
  const run = (extra = {}) => spawnSync(process.execPath, [path.join(root, "scripts/ci/readiness-source.mjs")], {
    cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_SHA: head, GITHUB_EVENT_PATH: event, ...extra },
  });
  return { dir, git, head, installed, run };
}

test("identity metadata keeps the resolved checkout separate from the PR head", () => {
  const fixture = metadataFixture();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.veritasVersion, "1.12.2");
  assert.equal(receipt.base, fixture.head);
  assert.equal(receipt.head, fixture.head);
  assert.equal(receipt.githubSha, fixture.head);
  assert.equal(receipt.prHead, "b".repeat(40));
  assert.match(receipt.qualification, /not PR-head execution/);
});

test("identity metadata refuses a different installed pin or GitHub checkout", () => {
  const fixture = metadataFixture();
  fs.writeFileSync(fixture.installed, JSON.stringify({ version: "1.11.2" }));
  const oldTool = fixture.run();
  assert.notEqual(oldTool.status, 0);
  assert.equal(oldTool.stdout, "");
  assert.match(oldTool.stderr, /Pinned readiness requires Veritas 1\.12\.2/);
  fs.writeFileSync(fixture.installed, JSON.stringify({ version: "1.12.2" }));
  const wrongCheckout = fixture.run({ GITHUB_SHA: "a".repeat(40) });
  assert.notEqual(wrongCheckout.status, 0);
  assert.equal(wrongCheckout.stdout, "");
  assert.match(wrongCheckout.stderr, /checkout differs from GITHUB_SHA/);
  const missingIdentity = fixture.run({ GITHUB_ACTIONS: "true", GITHUB_SHA: "" });
  assert.notEqual(missingIdentity.status, 0);
  assert.equal(missingIdentity.stdout, "");
  assert.match(missingIdentity.stderr, /requires its SHA and event identity/);
  fixture.git("update-ref", "-d", "refs/remotes/origin/main");
  const missingBase = fixture.run();
  assert.notEqual(missingBase.status, 0);
  assert.equal(missingBase.stdout, "");
});
