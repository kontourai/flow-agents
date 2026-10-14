import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillPath = fileURLToPath(
  new URL("../../kits/builder/skills/release-readiness/SKILL.md", import.meta.url),
);

test("Builder release readiness consumes the installed Veritas verdict contract", () => {
  const skill = readFileSync(skillPath, "utf8");

  assert.match(skill, /npx --no @kontourai\/veritas readiness --check evidence/);
  // A registry-fetching, version-pinned spelling drifts from the repository's install.
  assert.doesNotMatch(skill, /--package=@kontourai\/veritas@/);
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
