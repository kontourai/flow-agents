import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

import { bootstrapProviders, detectGitHubRepo } from "../../build/src/cli/provider-bootstrap.js";

function repoFixture(owner = "example", name = "product") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-repo-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", `git@github.com:${owner}/${name}.git`]);
  return root;
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readArgvLog(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(1).split("\x1f"));
}

async function waitForPath(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

test("detectGitHubRepo accepts SSH origin and returns a canonical HTTPS URL", () => {
  const repo = repoFixture("acme", "widgets");
  assert.deepEqual(detectGitHubRepo(repo), {
    owner: "acme",
    name: "widgets",
    url: "https://github.com/acme/widgets",
  });
});

test("detectGitHubRepo rejects control characters and non-GitHub repository slugs", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "remote", "set-url", "origin", "https://github.com/example/product%0A--help"]);
  assert.throws(() => detectGitHubRepo(repo), /not a supported github\.com/);
  execFileSync("git", ["-C", repo, "remote", "set-url", "origin", "https://evil.example/github.com/acme/widgets"]);
  assert.throws(() => detectGitHubRepo(repo), /not a supported github\.com/);
});

test("offline project bootstrap writes all three schema-valid provider bindings", () => {
  const repo = repoFixture();
  const settings = path.join(repo, "generated-settings");
  const result = bootstrapProviders({
    scope: "project",
    repoPath: repo,
    projectSettingsRoot: settings,
    projectNumber: 7,
  });
  assert.equal(result.files.length, 3);
  assert.match(result.offlineRemediation, /'gh' auth status/);
  assert.match(result.offlineRemediation, /project view 7/);
  assert.match(result.offlineRemediation, /label list --repo 'example\/product' '--search=agent:claimed'/);
  assert.doesNotMatch(result.offlineRemediation, /github\.com\/example\/product/);
  const backlog = read(path.join(settings, "backlog-provider-settings.json"));
  const assignment = read(path.join(settings, "assignment-provider-settings.json"));
  const change = read(path.join(settings, "change-provider-settings.json"));
  assert.equal(backlog.projects[0].board_provider.board.number, 7);
  assert.equal(backlog.projects[0].work_item_provider.repo.owner, "example");
  assert.equal(assignment.projects[0].policy.label_name, "agent:claimed");
  assert.equal(change.projects[0].provider.executor, "gh-cli");
});

test("global bootstrap replaces only the matching repository entry", () => {
  const repo = repoFixture();
  const settings = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-global-"));
  const file = path.join(settings, "assignment-provider-settings.json");
  fs.writeFileSync(file, JSON.stringify({
    schema_version: "1.0",
    projects: [{
      project: { repo: { owner: "other", name: "repo" } },
      provider: { kind: "local-file", capabilities: [] },
      policy: {
        label_name: "claimed",
        claim_comment_marker: "<!-- claim -->",
        human_assignee_policy: { behavior: "never_reclaim", idle_threshold_days: 0 },
      },
    }],
  }));
  bootstrapProviders({
    scope: "global",
    repoPath: repo,
    globalSettingsRoot: settings,
    projectNumber: 2,
  });
  const assignment = read(file);
  assert.equal(assignment.projects.length, 2);
  assert.equal(assignment.projects.find((entry) => entry.project.repo.owner === "other").project.repo.name, "repo");
  assert.equal(assignment.projects.find((entry) => entry.project.repo.owner === "example").project.repo.name, "product");
});

test("global bootstrap serializes the full read-modify-write transaction", async () => {
  const repoA = repoFixture("example", "product-a");
  const repoB = repoFixture("example", "product-b");
  const settings = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-serialized-"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-lock-gh-"));
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "project list" ]]; then
  printf '{"projects":[{"number":9,"url":"https://github.com/orgs/example/projects/9"}]}'
elif [[ "$1 $2" == "label list" ]]; then
  sleep 1
  printf '[{"name":"agent:claimed"}]'
fi
`);
  fs.chmodSync(gh, 0o755);
  const common = [
    "build/src/cli.js", "provider-bootstrap",
    "--scope", "global",
    "--global-settings-root", settings,
    "--provider-project", "9",
    "--online",
  ];
  const first = spawn(process.execPath, [...common, "--repo-path", repoA], {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    stdio: "ignore",
  });
  await waitForPath(path.join(settings, ".provider-bootstrap.lock"));
  const blocked = spawnSync(process.execPath, [...common, "--repo-path", repoB], {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /locked by another setup/);
  assert.equal(await waitForExit(first), 0);
  const second = spawnSync(process.execPath, [...common, "--repo-path", repoB], {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const projects = read(path.join(settings, "backlog-provider-settings.json")).projects;
  assert.deepEqual(projects.map((entry) => entry.project.repo.name).sort(), ["product-a", "product-b"]);
});

test("bootstrap refuses to follow an existing settings symlink", () => {
  const repo = repoFixture();
  const settings = path.join(repo, "symlink-settings");
  fs.mkdirSync(settings);
  const outside = path.join(settings, "outside.json");
  const target = path.join(settings, "backlog-provider-settings.json");
  fs.writeFileSync(outside, JSON.stringify({ schema_version: "1.0", projects: [] }));
  fs.symlinkSync(outside, target);
  assert.throws(() => bootstrapProviders({
    scope: "project",
    repoPath: repo,
    projectSettingsRoot: settings,
    projectNumber: 2,
  }), /must be a regular file/);
  assert.deepEqual(read(outside), { schema_version: "1.0", projects: [] });
});

test("project bootstrap rejects a settings parent symlink that escapes the repository", () => {
  const repo = repoFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-parent-symlink-"));
  fs.symlinkSync(outside, path.join(repo, "context"));
  assert.throws(() => bootstrapProviders({
    scope: "project",
    repoPath: repo,
    projectSettingsRoot: path.join(repo, "context", "settings"),
    projectNumber: 2,
  }), /symbolic link|outside the repository/);
  assert.equal(fs.existsSync(path.join(outside, "settings")), false);
});

test("rerunning bootstrap preserves consumer-owned policy and selection", () => {
  const repo = repoFixture();
  const settings = path.join(repo, "custom-settings");
  bootstrapProviders({ scope: "project", repoPath: repo, projectSettingsRoot: settings, projectNumber: 2 });
  const backlogFile = path.join(settings, "backlog-provider-settings.json");
  const assignmentFile = path.join(settings, "assignment-provider-settings.json");
  const backlog = read(backlogFile);
  backlog.projects[0].project.paths = ["packages/api"];
  backlog.projects[0].selection.filters.include_labels = ["ready-for-agent"];
  backlog.projects[0].selection.wip_policy.block_new_work_when_active_count_exceeds = 3;
  fs.writeFileSync(backlogFile, JSON.stringify(backlog));
  const assignment = read(assignmentFile);
  assignment.projects[0].project.paths = ["packages/api"];
  assignment.projects[0].policy.label_name = "automation:held";
  assignment.projects[0].policy.human_assignee_policy.behavior = "never_reclaim";
  fs.writeFileSync(assignmentFile, JSON.stringify(assignment));
  bootstrapProviders({ scope: "project", repoPath: repo, projectSettingsRoot: settings, projectNumber: 5 });
  const updatedBacklog = read(backlogFile);
  const updatedAssignment = read(assignmentFile);
  const scopedBacklog = updatedBacklog.projects.find((entry) => entry.project.paths?.[0] === "packages/api");
  const scopedAssignment = updatedAssignment.projects.find((entry) => entry.project.paths?.[0] === "packages/api");
  const rootBacklog = updatedBacklog.projects.find((entry) => !entry.project.paths);
  assert.deepEqual(scopedBacklog.selection.filters.include_labels, ["ready-for-agent"]);
  assert.equal(scopedBacklog.selection.wip_policy.block_new_work_when_active_count_exceeds, 3);
  assert.equal(scopedBacklog.board_provider.board.number, 2);
  assert.equal(scopedAssignment.policy.label_name, "automation:held");
  assert.equal(scopedAssignment.policy.human_assignee_policy.behavior, "never_reclaim");
  assert.equal(rootBacklog.board_provider.board.number, 5);
  const scopedPath = path.join(repo, "packages", "api");
  fs.mkdirSync(scopedPath, { recursive: true });
  const missingGlobal = path.join(repo, "missing-global.json");
  const rootEffective = spawnSync(process.execPath, [
    "build/src/cli.js", "effective-backlog-settings",
    "--repo-path", repo, "--project-settings", backlogFile, "--global-settings", missingGlobal, "--json",
  ], { encoding: "utf8" });
  const scopedEffective = spawnSync(process.execPath, [
    "build/src/cli.js", "effective-backlog-settings",
    "--repo-path", scopedPath, "--project-settings", backlogFile, "--global-settings", missingGlobal, "--json",
  ], { encoding: "utf8" });
  const scopedAssignmentEffective = spawnSync(process.execPath, [
    "build/src/cli.js", "effective-assignment-provider-settings",
    "--repo-path", scopedPath, "--project-settings", assignmentFile, "--global-settings", missingGlobal, "--json",
  ], { encoding: "utf8" });
  assert.equal(rootEffective.status, 0, rootEffective.stderr);
  assert.equal(scopedEffective.status, 0, scopedEffective.stderr);
  assert.equal(scopedAssignmentEffective.status, 0, scopedAssignmentEffective.stderr);
  assert.equal(JSON.parse(rootEffective.stdout).settings.board_provider.board.number, 5);
  assert.equal(JSON.parse(scopedEffective.stdout).settings.board_provider.board.number, 2);
  assert.equal(JSON.parse(scopedAssignmentEffective.stdout).settings.policy.label_name, "automation:held");
});

test("online bootstrap verifies auth, discovers a sole project, and creates a missing claim label", () => {
  const repo = repoFixture();
  const settings = path.join(repo, "online-settings");
  bootstrapProviders({ scope: "project", repoPath: repo, projectSettingsRoot: settings, projectNumber: 9 });
  const assignmentFile = path.join(settings, "assignment-provider-settings.json");
  const assignment = read(assignmentFile);
  assignment.projects[0].policy.label_name = "-automation";
  fs.writeFileSync(assignmentFile, JSON.stringify(assignment));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-gh-"));
  const log = path.join(fakeBin, "calls.log");
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
printf '\\x1f%s' "$@" >> "${log}"
printf '\\n' >> "${log}"
if [[ "$1 $2" == "project list" ]]; then
  printf '{"projects":[{"number":9,"title":"Delivery","url":"https://github.com/orgs/example/projects/9"}]}'
elif [[ "$1 $2" == "label list" ]]; then
  printf '[]'
fi
`);
  fs.chmodSync(gh, 0o755);
  const result = bootstrapProviders({
    scope: "project",
    repoPath: repo,
    projectSettingsRoot: settings,
    online: true,
    ghBin: gh,
  });
  assert.equal(result.project.number, 9);
  const calls = readArgvLog(log);
  assert.deepEqual(calls, [
    ["auth", "status", "--hostname", "github.com"],
    ["project", "list", "--owner", "example", "--limit", "100", "--format", "json"],
    ["label", "list", "--repo", "example/product", "--search=-automation", "--limit", "100", "--json", "name"],
    [
      "label", "create",
      "--repo", "example/product",
      "--color", "5319E7",
      "--description", "Work item currently claimed by an agent",
      "--", "-automation",
    ],
  ]);
});

test("headless init can establish all provider settings in the installed project", () => {
  const repo = repoFixture();
  const dest = repo;
  const result = spawnSync(process.execPath, [
    "build/src/cli.js", "init",
    "--runtime", "base",
    "--dest", dest,
    "--telemetry-sink", "local-files",
    "--configure-providers",
    "--provider-project", "4",
    "--yes",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const name of [
    "backlog-provider-settings.json",
    "assignment-provider-settings.json",
    "change-provider-settings.json",
  ]) assert.equal(fs.existsSync(path.join(dest, "context", "settings", name)), true, name);
  for (const [command, name] of [
    ["effective-backlog-settings", "backlog-provider-settings.json"],
    ["effective-assignment-provider-settings", "assignment-provider-settings.json"],
    ["effective-change-provider-settings", "change-provider-settings.json"],
  ]) {
    const effective = spawnSync(process.execPath, [
      "build/src/cli.js", command,
      "--repo-path", repo,
      "--project-settings", path.join(dest, "context", "settings", name),
      "--global-settings", path.join(dest, "missing-global.json"),
      "--json",
    ], { encoding: "utf8" });
    assert.equal(effective.status, 0, `${command}\n${effective.stdout}\n${effective.stderr}`);
    assert.equal(JSON.parse(effective.stdout).status, "configured");
  }

  const assignment = read(path.join(dest, "context", "settings", "assignment-provider-settings.json")).projects[0];
  const actorKey = "bootstrap-runtime-actor";
  const providerLogin = "bootstrap-provider-login";
  const workItem = "example/product#44";
  const slug = "example-product-44";
  const actorFile = path.join(dest, "bootstrap-actor.json");
  const inputFile = path.join(dest, "bootstrap-claim-input.json");
  const issueFile = path.join(dest, "bootstrap-issue.json");
  const livenessFile = path.join(dest, "bootstrap-liveness.json");
  const statusFile = path.join(dest, "bootstrap-status.json");
  const artifactRoot = path.join(dest, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${slug}--pull-work.md`), `# Pull Work\n\nSelected Work Item: ${workItem}\n`);
  fs.writeFileSync(actorFile, JSON.stringify({
    runtime: "explicit-override", session_id: actorKey, host: os.hostname(), human: null,
  }));
  fs.writeFileSync(inputFile, JSON.stringify({
    repo: assignment.provider.repo,
    issue_number: 44,
    assignee_login: providerLogin,
    label_name: assignment.policy.label_name,
    claim_comment_marker: assignment.policy.claim_comment_marker,
    actor_key: actorKey,
    work_item_ref: workItem,
    branch: `agent/${actorKey}/${slug}`,
    artifact_dir: `.kontourai/flow-agents/${slug}`,
  }));
  const rendered = spawnSync(process.execPath, [
    "build/src/cli.js", "assignment-provider", "render-claim",
    "--provider", "github",
    "--subject-id", slug,
    "--input-json", inputFile,
    "--actor-json", actorFile,
  ], { encoding: "utf8" });
  assert.equal(rendered.status, 0, `${rendered.stdout}\n${rendered.stderr}`);
  const claim = JSON.parse(rendered.stdout);
  fs.writeFileSync(issueFile, JSON.stringify({
    number: 44,
    state: "OPEN",
    assignees: [{ login: providerLogin }],
    labels: [{ name: assignment.policy.label_name }],
    comments: [{
      id: "IC_bootstrap_44",
      createdAt: "2026-07-24T18:00:00Z",
      author: { login: providerLogin },
      body: claim.claim_comment_body,
    }],
  }));
  fs.writeFileSync(livenessFile, "[]\n");
  const status = spawnSync(process.execPath, [
    "build/src/cli.js", "assignment-provider", "status",
    "--provider", "github",
    "--repo", "example/product",
    "--issue-json", issueFile,
    "--subject-id", slug,
    "--liveness-events-json", livenessFile,
    "--self-actor", actorKey,
  ], { encoding: "utf8" });
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  fs.writeFileSync(statusFile, status.stdout);
  const assignmentStatus = JSON.parse(status.stdout);
  assert.equal(assignmentStatus.effective.effective_state, "held");
  assert.equal(assignmentStatus.effective.reason, "self_is_holder");
  const started = spawnSync(process.execPath, [
    "build/src/cli.js", "workflow", "start",
    "--artifact-root", artifactRoot,
    "--flow", "builder.build",
    "--work-item", workItem,
    "--assignment-provider", "github",
    "--effective-state-json", statusFile,
  ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey } });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
});

test("universal bundles do not contain Flow Agents dogfood provider bindings", () => {
  const built = spawnSync(process.execPath, ["build/src/cli.js", "build-bundles"], { encoding: "utf8" });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  for (const runtime of ["base", "codex", "claude-code", "kiro", "opencode", "pi"]) {
    for (const name of [
      "backlog-provider-settings.json",
      "assignment-provider-settings.json",
      "change-provider-settings.json",
    ]) {
      assert.equal(fs.existsSync(path.join("dist", runtime, "context", "settings", name)), false, `${runtime}/${name}`);
    }
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-kiro-upgrade-"));
  const consumerSettings = path.join(dest, "context", "settings", "backlog-provider-settings.json");
  const consumerBytes = '{"consumer_owned":true}\n';
  fs.mkdirSync(path.dirname(consumerSettings), { recursive: true });
  fs.writeFileSync(consumerSettings, consumerBytes);
  const installed = spawnSync("bash", ["dist/kiro/install.sh", dest], { encoding: "utf8" });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.equal(fs.readFileSync(consumerSettings, "utf8"), consumerBytes);
});
