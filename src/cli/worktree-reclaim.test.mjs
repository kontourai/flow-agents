import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { reclaimBuilderWorktree } from "../../build/src/cli/worktree-reclaim.js";

test("reclaim removes only the clean merged linked worktree, retains its branch, and persists a receipt", async () => {
  const fixture = makeFixture();
  try {
    const receipt = await reclaimBuilderWorktree(fixture.sessionDir, {
      observeMergedChange: async ({ expected }) => ({
        state: "merged",
        mergeSha: "b".repeat(40),
        headSha: expected.headSha,
        headRef: expected.headRef,
        baseRef: expected.baseRef,
        providerActor: expected.providerActor,
        observedAt: "2026-07-23T23:00:00.000Z",
      }),
      now: () => "2026-07-23T23:01:00.000Z",
    });
    assert.equal(receipt.outcome, "reclaimed");
    assert.equal(fs.existsSync(fixture.worktree), false);
    assert.equal(git(fixture.primary, "show-ref", "--verify", "--quiet", "refs/heads/feature"), "");
    const receipts = path.join(fixture.primary, ".kontourai", "flow-agents", "worktree-reclaims");
    const files = fs.readdirSync(receipts);
    assert.equal(files.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(receipts, files[0]), "utf8"));
    assert.deepEqual(stored, receipt);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(fixture.primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reclaim can finish when the invoking process starts inside the worktree being removed", () => {
  const fixture = makeFixture();
  try {
    const moduleUrl = pathToFileURL(path.resolve("build/src/cli/worktree-reclaim.js")).href;
    const script = `
      import { reclaimBuilderWorktree } from ${JSON.stringify(moduleUrl)};
      const receipt = await reclaimBuilderWorktree(process.argv[1], {
        observeMergedChange: async ({ expected }) => ({
          state: "merged", mergeSha: "d".repeat(40), headSha: expected.headSha,
          headRef: expected.headRef, baseRef: expected.baseRef,
          providerActor: expected.providerActor, observedAt: "2026-07-23T23:00:00.000Z"
        })
      });
      process.stdout.write(JSON.stringify(receipt));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, fixture.sessionDir], {
      cwd: fixture.worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(output).outcome, "reclaimed");
    assert.equal(fs.existsSync(fixture.worktree), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reclaim refuses dirty worktrees before provider observation", async () => {
  const fixture = makeFixture();
  let observations = 0;
  try {
    fs.writeFileSync(path.join(fixture.worktree, "dirty.txt"), "not committed\n");
    await assert.rejects(
      reclaimBuilderWorktree(fixture.sessionDir, {
        observeMergedChange: async () => {
          observations += 1;
          throw new Error("should not observe");
        },
      }),
      /refuses a dirty worktree/,
    );
    assert.equal(observations, 0);
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reclaim refuses before accepted learning evidence", async () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.sessionDir, "trust.bundle"), JSON.stringify({ schemaVersion: 5, claims: [] }));
    await assert.rejects(
      reclaimBuilderWorktree(fixture.sessionDir, { observeMergedChange: async () => { throw new Error("should not observe"); } }),
      /requires only accepted current builder\.learn\.decisions/,
    );
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-reclaim-"));
  const primary = path.join(root, "repo");
  const worktree = path.join(root, "repo-worktrees", "feature");
  fs.mkdirSync(primary, { recursive: true });
  git(primary, "init", "-b", "main");
  git(primary, "config", "user.email", "fixture@example.test");
  git(primary, "config", "user.name", "Fixture");
  git(primary, "remote", "add", "origin", "git@github.com:acme/example.git");
  fs.mkdirSync(path.join(primary, "context", "settings"), { recursive: true });
  fs.writeFileSync(path.join(primary, ".gitignore"), ".kontourai/\n");
  fs.writeFileSync(path.join(primary, "context", "settings", "change-provider-settings.json"), JSON.stringify({
    schema_version: "1.0",
    defaults: {
      provider: {
        role: "ChangeProvider",
        kind: "github",
        repository: { owner: "acme", name: "example" },
        capabilities: ["change.create", "change.observe"],
        executor: "gh-cli",
      },
    },
  }));
  fs.writeFileSync(path.join(primary, "base.txt"), "base\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "base");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(primary, "worktree", "add", "-b", "feature", worktree);
  fs.writeFileSync(path.join(worktree, "feature.txt"), "feature\n");
  git(worktree, "add", "feature.txt");
  git(worktree, "commit", "-m", "feature");
  const headSha = git(worktree, "rev-parse", "HEAD").trim();
  const sessionDir = path.join(worktree, ".kontourai", "flow-agents", "fixture");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "trust.bundle"), JSON.stringify({
    schemaVersion: 5,
    claims: [
      { claimType: "builder.learn.decisions", status: "verified" },
      { claimType: "builder.learn.evidence", status: "verified" },
    ],
  }));
  fs.writeFileSync(path.join(sessionDir, "publish-change.result.json"), JSON.stringify({
    schema_version: "1.0",
    operation: "publish-change",
    repository: { owner: "acme", name: "example" },
    provider: { kind: "github", configuration_id: "fixture", adapter: "github-gh-cli" },
    change_ref: {
      provider_record_id: "PR_fixture",
      number: 42,
      url: "https://github.com/acme/example/pull/42",
      state: "open",
      base_ref: "main",
      head_ref: "feature",
      head_sha: headSha,
    },
    provider_actor: "fixture-actor",
  }));
  return { root, primary, worktree, sessionDir };
}

function git(cwd, ...argv) {
  return execFileSync("/usr/bin/git", ["-C", cwd, ...argv], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
