import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import YAML from "yaml";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("Codex PR review action focused shell suite reports its full passing contract", () => {
  const result = spawnSync("bash", ["evals/static/test_codex_pr_review_action.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");

  assert.equal(result.status, 0, diagnostic || "focused shell suite exited without output");
  assert.match(
    result.stdout,
    /Results: 74\/74 passed, 0 failed(?:\r?\n|$)/,
    "focused shell suite must report every expected contract assertion passing",
  );
});

// Execute the actual YAML shell body with a recording CLI, without credentials
// or provider traffic. This proves argv/cwd/stdout wiring, not Kiro policy.
test("Kiro invocation passes the exact read tool allowlist from a separate directory", () => {
  const action = YAML.parse(fs.readFileSync(path.join(repoRoot, ".github/actions/codex-pr-review/action.yml"), "utf8"));
  const step = action.runs.steps.find(step => step.id === "kiro");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-invocation-"));
  try {
    const home = path.join(temp, "home");
    const cwd = path.join(temp, "trusted");
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    fs.mkdirSync(cwd);
    assert.deepEqual(fs.readdirSync(cwd), []);
    assert.equal(step["working-directory"], "${{ steps.prepare.outputs['review-working-directory'] }}");
    const capture = path.join(temp, "argv.json");
    fs.writeFileSync(path.join(home, ".local/bin/kiro-cli"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));
console.error("stderr probe");
console.log('> {"verdict":"pass","summary":"fixture","coverage":[{"lane":"code","status":"pass","summary":"fixture"}],"findings":[],"gaps":[]}');
`, { mode: 0o700 });
    const prompt = path.join(temp, "prompt.md");
    const raw = path.join(temp, "raw.txt");
    const assessment = path.join(temp, "assessment.json");
    fs.writeFileSync(prompt, "trusted fixture prompt");
    const command = step.run.replaceAll("${{ github.action_path }}", path.join(repoRoot, ".github/actions/codex-pr-review"));
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
      cwd, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, CAPTURE: capture, REVIEW_PROMPT_FILE: prompt,
        REVIEW_RAW_OUTPUT_FILE: raw, REVIEW_ASSESSMENT_FILE: assessment, REVIEW_MODEL: "fixture-model", REVIEW_EFFORT: "high" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)), {cwd: fs.realpathSync(cwd), argv:["chat", "--no-interactive", "--trust-tools=fs_read,grep,glob", "--model", "fixture-model", "--effort", "high", "trusted fixture prompt"]});
    assert.match(result.stderr, /stderr probe/);
    assert.doesNotMatch(fs.readFileSync(raw, "utf8"), /stderr probe/);
    assert.equal(JSON.parse(fs.readFileSync(assessment)).verdict, "pass");
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test("prepare-bound evidence remains available after finalize hard failure", () => {
  const action = YAML.parse(fs.readFileSync(path.join(repoRoot, ".github/actions/codex-pr-review/action.yml"), "utf8"));
  assert.equal(action.outputs["review-directory"].value, "${{ steps.prepare.outputs['review-working-directory'] }}");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-retention-"));
  try {
    const repo = path.join(temp, "repo");
    fs.mkdirSync(repo);
    const git = (...args) => {
      const result = spawnSync("git", ["-C", repo, ...args], {encoding:"utf8"});
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "base");
    const sha = git("rev-parse", "HEAD");
    const output = path.join(temp, "outputs");
    const env = { PATH:process.env.PATH, RUNNER_TEMP:temp, GITHUB_OUTPUT:output, REVIEW_ENGINE:"kiro",
      REVIEW_REPOSITORY:"fixture/repository", REVIEW_PULL_REQUEST:"1", REVIEW_BASE_SHA:sha, REVIEW_HEAD_SHA:sha,
      REVIEW_MODEL:"fixture-model", REVIEW_EFFORT:"high", REVIEW_RUN_ID:"1", REVIEW_TRIGGER_ACTOR:"fixture", REVIEW_WORKSPACE:repo };
    const runner = path.join(repoRoot, "scripts/ci/codex-pr-review.mjs");
    const prepared = spawnSync(process.execPath, [runner, "prepare"], {env, encoding:"utf8"});
    assert.equal(prepared.status, 0, prepared.stderr);
    const outputs = Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at+1)];
    }));
    const raw = "> malformed fixture stdout\n";
    fs.writeFileSync(outputs["raw-output-file"], raw);
    fs.writeFileSync(outputs["assessment-file"], "{");
    const failed = spawnSync(process.execPath, [runner, "finalize"], {encoding:"utf8", env:{...env,
      REVIEW_TARGET_FILE:outputs["target-file"], REVIEW_ASSESSMENT_FILE:outputs["assessment-file"], REVIEW_RESULT_FILE:outputs["result-file"] }});
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /not readable JSON/);
    assert.equal(fs.existsSync(outputs["result-file"]), false);
    assert.equal(fs.readFileSync(outputs["raw-output-file"], "utf8"), raw);
    assert.equal(fs.readFileSync(outputs["assessment-file"], "utf8"), "{");
    for (const key of ["target-file", "prompt-file", "raw-output-file", "assessment-file"]) {
      assert.equal(path.dirname(outputs[key]), outputs["review-working-directory"]);
      assert.equal(fs.existsSync(outputs[key]), true);
    }
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
});
