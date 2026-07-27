import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

import { bootstrapProviders, detectGitHubRepo, setProviderBootstrapTestHooksForTest } from "../../build/src/cli/provider-bootstrap.js";

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

function snapshotTree(root) {
  if (!fs.existsSync(root)) return [];
  const visit = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? visit(file) : [[path.relative(root, file), fs.readFileSync(file).toString("base64")]];
  });
  return visit(root).sort(([left], [right]) => left.localeCompare(right));
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

test("provider pickup derives one exact branch-bound claim and start plan without remote mutation", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  try {
    const result = bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: path.join(repo, "context", "settings"),
      projectNumber: 7,
      workItemRef: "example/product#44",
      providerLogin: "provider-login",
      providerBranch: "agent/provider-pickup",
    });
    const pickup = result.pickup;
    assert.ok(pickup);
    assert.equal(pickup.slug, "example-product-44");
    assert.equal(pickup.provider_branch, "agent/provider-pickup");
    assert.equal(pickup.actor.actorKey, "pickup-runtime-actor");
    assert.equal(pickup.claim.record.subject_id, "example-product-44");
    assert.equal(pickup.claim.record.work_item_ref, "example/product#44");
    assert.equal(pickup.claim.record.branch, "agent/provider-pickup");
    assert.deepEqual(pickup.operations.claim[0], [
      "gh", "issue", "edit", "44", "--repo", "example/product", "--add-assignee", "provider-login",
    ]);
    assert.deepEqual(pickup.operations.observe_issue.argv, [
      "gh", "issue", "view", "44", "--repo", "example/product", "--json", "number,state,assignees,labels,comments",
    ]);
    assert.deepEqual(pickup.operations.start_workflow.argv.slice(-6), [
      "--work-item", "example/product#44", "--assignment-provider", "github", "--effective-state-json", pickup.artifacts.effective_state_file,
    ]);
    assert.equal(read(pickup.artifacts.plan_file).provider_branch, "agent/provider-pickup");
    assert.equal(read(pickup.artifacts.claim_input_file).artifact_dir, ".kontourai/flow-agents/example-product-44");
    assert.deepEqual(read(pickup.artifacts.liveness_events_file), []);

    const repeated = bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: path.join(repo, "context", "settings"),
      projectNumber: 7,
      workItemRef: "example/product#44",
      providerLogin: "provider-login",
    });
    assert.deepEqual(repeated.pickup, pickup, "rerun reuses the exact prepared claim generation");

    fs.writeFileSync(pickup.artifacts.issue_snapshot_file, JSON.stringify({
      number: 44,
      state: "OPEN",
      assignees: [{ login: "provider-login" }],
      labels: [{ name: "agent:claimed" }],
      comments: [{
        id: "IC_pickup_44",
        createdAt: pickup.claim.record.claimed_at,
        author: { login: "provider-login" },
        body: pickup.claim.claim_comment_body,
      }],
    }));
    const status = spawnSync(process.execPath, [
      "build/src/cli.js",
      ...pickup.operations.derive_effective_state.argv.slice(1),
    ], { encoding: "utf8" });
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    fs.writeFileSync(pickup.operations.derive_effective_state.stdout_file, status.stdout);
    assert.equal(JSON.parse(status.stdout).effective.reason, "self_is_holder");

    fs.writeFileSync(
      path.join(pickup.session_dir, `${pickup.slug}--pull-work.md`),
      `# Pull Work\n\nSelected Work Item: ${pickup.work_item_ref}\n`,
    );
    const beforeBranchSwitch = snapshotTree(path.join(repo, ".kontourai"));
    execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/agent/branch-switch"]);
    const switched = spawnSync(process.execPath, [
      "build/src/cli.js",
      ...pickup.operations.start_workflow.argv.slice(1),
    ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: "pickup-runtime-actor" } });
    assert.notEqual(switched.status, 0);
    assert.match(switched.stderr, /actual Git worktree branch .* disagrees with validated provider assignment branch/);
    assert.deepEqual(snapshotTree(path.join(repo, ".kontourai")), beforeBranchSwitch, "branch disagreement must not mirror ownership or create session state");
    execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/agent/provider-pickup"]);
    const started = spawnSync(process.execPath, [
      "build/src/cli.js",
      ...pickup.operations.start_workflow.argv.slice(1),
    ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: "pickup-runtime-actor" } });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    assert.equal(read(path.join(pickup.session_dir, "state.json")).branch, "agent/provider-pickup");
  } finally {
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("provider pickup rejects ref, branch, actor, and artifact-root ambiguity before claim rendering", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  let caseNumber = 0;
  const rejectWithoutMutation = (overrides, pattern) => {
    caseNumber += 1;
    const projectSettingsRoot = path.join(repo, "context", `settings-${caseNumber}`);
    assert.throws(
      () => bootstrapProviders({
        scope: "project",
        repoPath: repo,
        projectSettingsRoot,
        projectNumber: 7,
        providerLogin: "provider-login",
        ...overrides,
      }),
      pattern,
    );
    assert.equal(fs.existsSync(projectSettingsRoot), false, "failed pickup preflight must not publish provider settings");
  };
  try {
    rejectWithoutMutation({ workItemRef: "other/product#44" }, /does not belong to detected repository/);
    rejectWithoutMutation(
      { workItemRef: "example/product", providerBranch: "agent/provider-pickup" },
      /exact owner\/repo#positive-numeric-id/,
    );
    rejectWithoutMutation(
      { workItemRef: "example/product#44", providerBranch: "agent/different" },
      /does not match the actual Git worktree branch/,
    );
    rejectWithoutMutation(
      { workItemRef: "example/product#44", artifactRoot: path.join(repo, "..", "outside") },
      /canonical <repository>\/\.kontourai\/flow-agents/,
    );
    rejectWithoutMutation(
      { workItemRef: "example/product#44", artifactRoot: path.join(repo, "custom-artifacts") },
      /canonical <repository>\/\.kontourai\/flow-agents/,
    );
  } finally {
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("incompatible provider pickup rejects before settings or online provider commands mutate", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const session = path.join(repo, ".kontourai", "flow-agents", "example-product-44");
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "provider-pickup.json"), `${JSON.stringify({
    schema_version: "1.0",
    role: "ProviderPickupPlan",
    work_item_ref: "example/product#44",
    provider_branch: "agent/provider-pickup",
    actor: { actorKey: "different-actor" },
    claim: { record: { claimed_at: "2026-07-25T00:00:00.000Z" } },
  })}\n`);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-rejection-gh-"));
  const log = path.join(fakeBin, "calls.log");
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 1\n`);
  fs.chmodSync(gh, 0o755);
  const settings = path.join(repo, "context", "settings");
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  try {
    assert.throws(() => bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      online: true,
      ghBin: gh,
      providerLogin: "provider-login",
      workItemRef: "example/product#44",
    }), /existing provider pickup plan does not match/);
    assert.equal(fs.existsSync(settings), false, "rejected pickup must not publish provider settings");
    assert.equal(fs.existsSync(log), false, "rejected pickup must not invoke remote provider commands");
  } finally {
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("pickup transaction rejects an injected race before remote commands and preserves the foreign file", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const settings = path.join(repo, "context", "settings");
  const session = path.join(repo, ".kontourai", "flow-agents", "example-product-44");
  const conflictingActor = path.join(session, "provider-pickup.actor.json");
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-race-gh-"));
  const log = path.join(fakeBin, "calls.log");
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 1\n`);
  fs.chmodSync(gh, 0o755);
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  setProviderBootstrapTestHooksForTest({
    afterLocksAcquired() {
      fs.writeFileSync(conflictingActor, `${JSON.stringify({ runtime: "hostile", session_id: "race", host: "race", human: null })}\n`);
    },
  });
  try {
    assert.throws(() => bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      online: true,
      ghBin: gh,
      projectNumber: 7,
      providerLogin: "provider-login",
      workItemRef: "example/product#44",
      providerBranch: "agent/provider-pickup",
    }), /publication target changed while the transaction lock was held/);
    assert.equal(fs.existsSync(settings), false);
    assert.deepEqual(read(conflictingActor), { runtime: "hostile", session_id: "race", host: "race", human: null });
    assert.equal(fs.existsSync(log), false, "local race rejection must precede every remote provider command");
  } finally {
    setProviderBootstrapTestHooksForTest(null);
    fs.unlinkSync(conflictingActor);
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("provider pickup rejects a branch change after locks before publishing local state", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const settings = path.join(repo, "context", "settings");
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  setProviderBootstrapTestHooksForTest({
    afterLocksAcquired() {
      execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/agent/changed-after-lock"]);
    },
  });
  try {
    assert.throws(() => bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      projectNumber: 7,
      workItemRef: "example/product#44",
      providerLogin: "provider-login",
      providerBranch: "agent/provider-pickup",
    }), /actual Git worktree branch .* no longer matches provider pickup branch/);
    assert.equal(fs.existsSync(settings), false, "branch rejection must not publish provider settings");
    assert.equal(fs.existsSync(path.join(repo, ".kontourai")), false, "branch rejection must not publish pickup artifacts");
  } finally {
    setProviderBootstrapTestHooksForTest(null);
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("provider pickup rejects a branch change by the remote label callback before local commit", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const settings = path.join(repo, "context", "settings");
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-branch-gh-"));
  const log = path.join(fakeBin, "calls.log");
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env bash
set -eu
printf '\\x1f%s' "$@" >> ${JSON.stringify(log)}
printf '\\n' >> ${JSON.stringify(log)}
if [[ "$1 $2" == "project list" ]]; then printf '{"projects":[{"number":7}]}'
elif [[ "$1 $2" == "label list" ]]; then printf '[]'
elif [[ "$1 $2" == "label create" ]]; then git -C ${JSON.stringify(repo)} symbolic-ref HEAD refs/heads/agent/changed-by-provider
fi
`);
  fs.chmodSync(gh, 0o755);
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  try {
    assert.throws(() => bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      online: true,
      ghBin: gh,
      projectNumber: 7,
      providerLogin: "provider-login",
      workItemRef: "example/product#44",
      providerBranch: "agent/provider-pickup",
    }), /actual Git worktree branch .* no longer matches provider pickup branch/);
    assert.ok(readArgvLog(log).some((argv) => argv[0] === "label" && argv[1] === "create"));
    assert.equal(fs.existsSync(settings), false, "provider branch mutation must not publish settings");
    assert.equal(fs.existsSync(path.join(repo, ".kontourai")), false, "provider branch mutation must not publish pickup artifacts");
  } finally {
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("provider pickup rechecks branch after each commit hook and rolls back earlier commits", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const settings = path.join(repo, "context", "settings");
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  try {
    bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      projectNumber: 7,
      workItemRef: "example/product#44",
      providerLogin: "provider-login",
      providerBranch: "agent/provider-pickup",
    });
    const settingsPreimage = snapshotTree(path.join(repo, "context"));
    const pickupPreimage = snapshotTree(path.join(repo, ".kontourai"));
    setProviderBootstrapTestHooksForTest({
      beforeCommit(_file, index) {
        if (index === 1) {
          execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/agent/changed-before-rename"]);
        }
      },
    });

    assert.throws(() => bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      projectNumber: 8,
      workItemRef: "example/product#44",
      providerLogin: "provider-login",
      providerBranch: "agent/provider-pickup",
    }), /actual Git worktree branch .* no longer matches provider pickup branch/);
    assert.deepEqual(snapshotTree(path.join(repo, "context")), settingsPreimage, "rollback must restore the earlier settings commit");
    assert.deepEqual(snapshotTree(path.join(repo, ".kontourai")), pickupPreimage, "branch rejection must not partially publish pickup artifacts");
  } finally {
    setProviderBootstrapTestHooksForTest(null);
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("pickup transaction restores exact local preimages when commit fails after label creation", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const settings = path.join(repo, "context", "settings");
  bootstrapProviders({ scope: "project", repoPath: repo, projectSettingsRoot: settings, projectNumber: 7 });
  const before = snapshotTree(path.join(repo, "context"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-commit-gh-"));
  const log = path.join(fakeBin, "calls.log");
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env bash
set -eu
printf '\\x1f%s' "$@" >> ${JSON.stringify(log)}
printf '\\n' >> ${JSON.stringify(log)}
if [[ "$1 $2" == "project list" ]]; then printf '{"projects":[{"number":7}]}'
elif [[ "$1 $2" == "label list" ]]; then printf '[]'
fi
`);
  fs.chmodSync(gh, 0o755);
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  setProviderBootstrapTestHooksForTest({
    beforeCommit(_file, index) {
      if (index === 5) throw new Error("injected pickup commit failure");
    },
  });
  try {
    assert.throws(() => bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      online: true,
      ghBin: gh,
      projectNumber: 7,
      providerLogin: "provider-login",
      workItemRef: "example/product#44",
      providerBranch: "agent/provider-pickup",
    }), /injected pickup commit failure/);
    assert.deepEqual(snapshotTree(path.join(repo, "context")), before, "settings must match exact preimages after rollback");
    assert.equal(fs.existsSync(path.join(repo, ".kontourai")), false, "new pickup files and directories must be removed after rollback");
    assert.ok(readArgvLog(log).some((argv) => argv[0] === "label" && argv[1] === "create"), "remote label creation is not rolled back");
  } finally {
    setProviderBootstrapTestHooksForTest(null);
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("pickup transaction rejects a late foreign write, preserves it, and restores earlier committed preimages", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const settings = path.join(repo, "context", "settings");
  const backlog = path.join(settings, "backlog-provider-settings.json");
  const assignment = path.join(settings, "assignment-provider-settings.json");
  const foreignBytes = "FOREIGN-WRITE\\n";
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  try {
    bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      projectNumber: 7,
      workItemRef: "example/product#44",
      providerLogin: "provider-login",
      providerBranch: "agent/provider-pickup",
    });
    const backlogPreimage = fs.readFileSync(backlog);
    let injected = false;
    setProviderBootstrapTestHooksForTest({
      beforeCommit(file, index) {
        if (index === 1) {
          fs.writeFileSync(file, foreignBytes);
          injected = true;
        }
      },
    });

    assert.throws(() => bootstrapProviders({
      scope: "project",
      repoPath: repo,
      projectSettingsRoot: settings,
      projectNumber: 8,
      workItemRef: "example/product#44",
      providerLogin: "provider-login",
      providerBranch: "agent/provider-pickup",
    }), /publication target changed while the transaction lock was held/);
    assert.equal(injected, true, "the late write must occur after the first transaction-owned commit");
    assert.deepEqual(fs.readFileSync(backlog), backlogPreimage, "rollback must restore the earlier transaction-owned commit");
    assert.equal(fs.readFileSync(assignment, "utf8"), foreignBytes, "rollback must preserve the foreign current target");
  } finally {
    setProviderBootstrapTestHooksForTest(null);
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
});

test("bootstrap, public workflow start, and sidecar share the GitHub Work Item reference corpus", () => {
  const repo = repoFixture();
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/provider-pickup"]);
  const artifactRoot = path.join(repo, ".kontourai", "flow-agents");
  const previousActor = process.env.FLOW_AGENTS_ACTOR;
  process.env.FLOW_AGENTS_ACTOR = "pickup-runtime-actor";
  try {
    for (const [ref, slug] of [
      ["example/product#1", "example-product-1"],
      ["example/product#9007199254740991", "example-product-9007199254740991"],
    ]) {
      const result = bootstrapProviders({
        scope: "project", repoPath: repo, projectSettingsRoot: path.join(repo, "context", "settings"),
        projectNumber: 7, providerLogin: "provider-login", workItemRef: ref,
      });
      assert.equal(result.pickup?.slug, slug);
      const sidecar = spawnSync(process.execPath, ["build/src/cli/workflow-sidecar.js", "resolve-slug", ref], { encoding: "utf8" });
      assert.equal(sidecar.status, 0, sidecar.stderr);
      assert.equal(sidecar.stdout.trim(), slug);
      const publicStart = spawnSync(process.execPath, [
        "build/src/cli.js", "workflow", "start", "--artifact-root", artifactRoot,
        "--flow", "builder.build", "--work-item", ref, "--assignment-provider", "local-file",
      ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: "pickup-runtime-actor" } });
      assert.notEqual(publicStart.status, 0);
      assert.match(publicStart.stderr, new RegExp(`requires concrete pull-work selection evidence.*${slug}`));
    }
    for (const ref of ["example/product#0", "example/product#9007199254740992"]) {
      const settings = path.join(repo, "context", `rejected-${ref.split("#")[1]}`);
      assert.throws(() => bootstrapProviders({
        scope: "project", repoPath: repo, projectSettingsRoot: settings,
        projectNumber: 7, providerLogin: "provider-login", workItemRef: ref,
      }), /positive-numeric-id|safe integer range/);
      const sidecar = spawnSync(process.execPath, ["build/src/cli/workflow-sidecar.js", "resolve-slug", ref], { encoding: "utf8" });
      assert.notEqual(sidecar.status, 0);
      assert.match(sidecar.stderr, /positive-numeric-id|safe integer range/);
      const publicStart = spawnSync(process.execPath, [
        "build/src/cli.js", "workflow", "start", "--artifact-root", artifactRoot,
        "--flow", "builder.build", "--work-item", ref, "--assignment-provider", "local-file",
      ], { encoding: "utf8" });
      assert.notEqual(publicStart.status, 0);
      assert.match(publicStart.stderr, /positive-numeric-id|safe integer range/);
      assert.equal(fs.existsSync(settings), false);
    }
  } finally {
    if (previousActor === undefined) delete process.env.FLOW_AGENTS_ACTOR;
    else process.env.FLOW_AGENTS_ACTOR = previousActor;
  }
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
  const entered = path.join(settings, "first-bootstrap-entered");
  const release = path.join(settings, "release-first-bootstrap");
  fs.writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "project list" ]]; then
  printf '{"projects":[{"number":9,"url":"https://github.com/orgs/example/projects/9"}]}'
elif [[ "$1 $2" == "label list" ]]; then
  if mkdir "$PROVIDER_BOOTSTRAP_ENTERED" 2>/dev/null; then
    attempts=0
    while [[ ! -e "$PROVIDER_BOOTSTRAP_RELEASE" ]]; do
      attempts=$((attempts + 1))
      if [[ "$attempts" -ge 600 ]]; then
        printf 'timed out waiting for provider-bootstrap test release\\n' >&2
        exit 98
      fi
      sleep 0.05
    done
  fi
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
  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    PROVIDER_BOOTSTRAP_ENTERED: entered,
    PROVIDER_BOOTSTRAP_RELEASE: release,
  };
  const first = spawn(process.execPath, [...common, "--repo-path", repoA], {
    env,
    stdio: "ignore",
  });
  const firstExit = waitForExit(first);
  let firstStatus;
  try {
    await waitForPath(path.join(settings, ".provider-bootstrap.lock"));
    await waitForPath(entered);
    const blocked = spawnSync(process.execPath, [...common, "--repo-path", repoB], {
      env,
      encoding: "utf8",
    });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /locked by another setup/);
  } finally {
    fs.writeFileSync(release, "release\n");
    firstStatus = await firstExit;
  }
  assert.equal(firstStatus, 0);
  const second = spawnSync(process.execPath, [...common, "--repo-path", repoB], {
    env,
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
  const providerBranch = "provider/authorized-example-product-44";
  execFileSync("git", ["-C", dest, "symbolic-ref", "HEAD", `refs/heads/${providerBranch}`]);
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
    branch: providerBranch,
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
  assert.equal(assignmentStatus.assignment.record.branch, providerBranch);
  const started = spawnSync(process.execPath, [
    "build/src/cli.js", "workflow", "start",
    "--artifact-root", artifactRoot,
    "--flow", "builder.build",
    "--work-item", workItem,
    "--assignment-provider", "github",
    "--effective-state-json", statusFile,
  ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey } });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  // A provider-backed session has one branch authority: the validated AssignmentStatus record.
  // Its immutable evidence, local lease mirror, session state/delivery record, and both current
  // projections must all retain that exact value; no locally derived agent branch is allowed.
  assert.equal(read(path.join(artifactRoot, "assignment", `${slug}.json`)).branch, providerBranch);
  assert.equal(read(path.join(sessionDir, "state.json")).branch, providerBranch);
  assert.match(fs.readFileSync(path.join(sessionDir, `${slug}--deliver.md`), "utf8"), new RegExp(`^branch: ${providerBranch}$`, "m"));
  assert.equal(read(path.join(artifactRoot, "current.json")).branch, providerBranch);
  const actorCurrent = fs.readdirSync(path.join(artifactRoot, "current"));
  assert.equal(actorCurrent.length, 1);
  assert.equal(read(path.join(artifactRoot, "current", actorCurrent[0])).branch, providerBranch);
  assert.equal(read(path.join(sessionDir, "assignment-provider-state.json")).assignment.record.branch, providerBranch);

  // Re-entry is a continuation of the same provider-authorized branch, not a fresh local
  // derivation. A caller also cannot add a competing public branch argument.
  const resumed = spawnSync(process.execPath, [
    "build/src/cli.js", "workflow", "start",
    "--artifact-root", artifactRoot,
    "--flow", "builder.build",
    "--work-item", workItem,
    "--assignment-provider", "github",
    "--effective-state-json", statusFile,
  ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey } });
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(read(path.join(sessionDir, "state.json")).branch, providerBranch);
  const callerBranch = spawnSync(process.execPath, [
    "build/src/cli.js", "workflow", "start",
    "--artifact-root", artifactRoot,
    "--flow", "builder.build",
    "--work-item", workItem,
    "--assignment-provider", "github",
    "--effective-state-json", statusFile,
    "--branch", "agent/caller-override",
  ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey } });
  assert.notEqual(callerBranch.status, 0);
  assert.match(callerBranch.stderr, /workflow start.*--branch|unknown flag/i);

  // A later provider result that claims a different branch cannot silently rewrite a resumed
  // session or its local mirror. The actual checkout check rejects it before any mutation.
  const mismatchedStatus = JSON.parse(status.stdout);
  mismatchedStatus.assignment.record.branch = "provider/conflicting-branch";
  const mismatchedFile = path.join(dest, "bootstrap-status-mismatched-branch.json");
  fs.writeFileSync(mismatchedFile, JSON.stringify(mismatchedStatus));
  const mismatched = spawnSync(process.execPath, [
    "build/src/cli.js", "workflow", "start",
    "--artifact-root", artifactRoot,
    "--flow", "builder.build",
    "--work-item", workItem,
    "--assignment-provider", "github",
    "--effective-state-json", mismatchedFile,
  ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey } });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /actual Git worktree branch .* disagrees with validated provider assignment branch/i);
  assert.equal(read(path.join(sessionDir, "state.json")).branch, providerBranch);

  // A provider-backed start fails closed when the claimed record omits its branch. The failed
  // start must not create a partial session in the new artifact root.
  const missingBranchStatus = JSON.parse(status.stdout);
  delete missingBranchStatus.assignment.record.branch;
  const missingFile = path.join(dest, "bootstrap-status-missing-branch.json");
  const missingRoot = path.join(dest, "missing-branch-project", ".kontourai", "flow-agents");
  const missingSession = path.join(missingRoot, slug);
  fs.mkdirSync(missingSession, { recursive: true });
  fs.writeFileSync(path.join(missingSession, `${slug}--pull-work.md`), `# Pull Work\n\nSelected Work Item: ${workItem}\n`);
  fs.writeFileSync(missingFile, JSON.stringify(missingBranchStatus));
  const missingBranch = spawnSync(process.execPath, [
    "build/src/cli.js", "workflow", "start",
    "--artifact-root", missingRoot,
    "--flow", "builder.build",
    "--work-item", workItem,
    "--assignment-provider", "github",
    "--effective-state-json", missingFile,
  ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey } });
  assert.notEqual(missingBranch.status, 0);
  assert.match(missingBranch.stderr, /AssignmentStatus.*claimed record and self_is_holder actor/i);
  assert.equal(fs.existsSync(path.join(missingSession, "state.json")), false);

  // Exact immutable provider evidence is checked before a local lease is mirrored. A resume
  // presenting different (but otherwise valid) AssignmentStatus bytes must fail without leaving
  // an assignment record or any session/current projection behind.
  const conflictingRoot = path.join(dest, "conflicting-snapshot-project", ".kontourai", "flow-agents");
  const conflictingSession = path.join(conflictingRoot, slug);
  const immutableSnapshot = path.join(conflictingSession, "assignment-provider-state.json");
  fs.mkdirSync(conflictingSession, { recursive: true });
  fs.writeFileSync(path.join(conflictingSession, `${slug}--pull-work.md`), `# Pull Work\n\nSelected Work Item: ${workItem}\n`);
  fs.writeFileSync(immutableSnapshot, status.stdout, { mode: 0o400 });
  const conflictingStatus = JSON.parse(status.stdout);
  conflictingStatus.observation_nonce = "different-but-valid-provider-observation";
  const conflictingStatusFile = path.join(dest, "bootstrap-status-conflicting-bytes.json");
  fs.writeFileSync(conflictingStatusFile, JSON.stringify(conflictingStatus));
  const conflictingSnapshotStart = spawnSync(process.execPath, [
    "build/src/cli.js", "workflow", "start",
    "--artifact-root", conflictingRoot,
    "--flow", "builder.build",
    "--work-item", workItem,
    "--assignment-provider", "github",
    "--effective-state-json", conflictingStatusFile,
  ], { encoding: "utf8", env: { ...process.env, FLOW_AGENTS_ACTOR: actorKey } });
  assert.notEqual(conflictingSnapshotStart.status, 0);
  assert.match(conflictingSnapshotStart.stderr, /provider state evidence conflicts with the existing immutable snapshot/i);
  assert.equal(fs.readFileSync(immutableSnapshot, "utf8"), status.stdout);
  assert.equal(fs.existsSync(path.join(conflictingRoot, "assignment", `${slug}.json`)), false);
  assert.equal(fs.existsSync(path.join(conflictingSession, "state.json")), false);
  assert.equal(fs.existsSync(path.join(conflictingSession, `${slug}--deliver.md`)), false);
  assert.equal(fs.existsSync(path.join(conflictingRoot, "current.json")), false);
  assert.equal(fs.existsSync(path.join(conflictingRoot, "current")), false);
});

test("universal bundles do not contain Flow Agents dogfood provider bindings", () => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-bundles-"));
  const built = spawnSync(process.execPath, ["build/src/cli.js", "build-bundles"], {
    encoding: "utf8",
    env: { ...process.env, FLOW_AGENTS_DIST_DIR: bundleRoot },
  });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  for (const runtime of ["base", "codex", "claude-code", "kiro", "opencode", "pi"]) {
    for (const name of [
      "backlog-provider-settings.json",
      "assignment-provider-settings.json",
      "change-provider-settings.json",
    ]) {
      assert.equal(fs.existsSync(path.join(bundleRoot, runtime, "context", "settings", name)), false, `${runtime}/${name}`);
    }
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "provider-bootstrap-kiro-upgrade-"));
  const consumerSettings = path.join(dest, "context", "settings", "backlog-provider-settings.json");
  const consumerBytes = '{"consumer_owned":true}\n';
  fs.mkdirSync(path.dirname(consumerSettings), { recursive: true });
  fs.writeFileSync(consumerSettings, consumerBytes);
  const installed = spawnSync("bash", [path.join(bundleRoot, "kiro", "install.sh"), dest], { encoding: "utf8" });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.equal(fs.readFileSync(consumerSettings, "utf8"), consumerBytes);
});
