import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillPath = fileURLToPath(
  new URL("../../kits/builder/skills/release-readiness/SKILL.md", import.meta.url),
);

test("Builder release readiness consumes the pinned Veritas verdict contract", () => {
  const skill = readFileSync(skillPath, "utf8");

  assert.match(
    skill,
    /npm exec --yes --package=@kontourai\/veritas@1\.5\.2 -- veritas readiness/,
  );
  assert.match(skill, /software-readiness-verdict/);
  assert.match(skill, /reportArtifactPath/);
  assert.match(skill, /record the[\s\S]*artifact reference in[\s\S]*release\.json/);
  assert.match(
    skill,
    /Observe\/advisory rollout,[\s\S]*NOT_VERIFIED[\s\S]*not an automatic Builder `HOLD`/,
  );
  assert.match(
    skill,
    /promoted Veritas governance to blocking enforcement,[\s\S]*routes to[\s\S]*`HOLD`/,
  );
});
