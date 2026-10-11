import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import { useFixtureGitHooks } from "./fixture-git.mjs";

test("fixture Git hooks isolate inherited hooks while project hooks and explicit overrides still execute", () => {
  const root = makeFixtureDir("flow-agents-fixture-git-");
  const project = path.join(root, "project");
  const ambientHooks = path.join(root, "ambient-hooks");
  fs.mkdirSync(project);
  fs.mkdirSync(ambientHooks);
  fs.writeFileSync(path.join(ambientHooks, "pre-commit"), "#!/bin/sh\necho fixture-ambient-hook-refused >&2\nexit 71\n", { mode: 0o700 });
  const config = path.join(root, "global-config");
  fs.writeFileSync(config, `[core]\n hooksPath = ${ambientHooks}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...argv) => execFileSync("git", argv, { cwd: project, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(project, "public.txt"), "public fixture\n");
  git("add", ".");
  assert.throws(() => git("commit", "-qm", "ambient refusal"), (error) => error.status === 1 && /fixture-ambient-hook-refused/.test(String(error.stderr)));

  useFixtureGitHooks(project);
  const hook = path.join(project, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nprintf 'project hook ran' > .git/project-hook-observation\n", { mode: 0o700 });
  git("commit", "-qm", "project hook");
  assert.equal(fs.readFileSync(path.join(project, ".git", "project-hook-observation"), "utf8"), "project hook ran");
  assert.equal(git("config", "--local", "core.hooksPath").trim(), ".git/hooks");
  assert.equal(fs.readFileSync(config, "utf8"), `[core]\n hooksPath = ${ambientHooks}\n`);

  git("config", "--local", "core.hooksPath", ambientHooks);
  assert.throws(() => git("commit", "--allow-empty", "-qm", "explicit override refusal"), (error) => error.status === 1 && /fixture-ambient-hook-refused/.test(String(error.stderr)));
});
