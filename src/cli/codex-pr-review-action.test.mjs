import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const aggregateStaticRun = process.env.FLOW_AGENTS_STATIC_AGGREGATE === "1";

test(
  "Codex PR review action focused shell suite reports its full passing contract",
  { skip: aggregateStaticRun ? "The dedicated required-lane check owns this focused suite." : false },
  () => {
    const result = spawnSync("bash", ["evals/static/test_codex_pr_review_action.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");

    assert.equal(result.status, 0, diagnostic || "focused shell suite exited without output");
    assert.match(
      result.stdout,
      /Results: 33\/33 passed, 0 failed(?:\r?\n|$)/,
      "focused shell suite must report every expected contract assertion passing",
    );
  },
);
