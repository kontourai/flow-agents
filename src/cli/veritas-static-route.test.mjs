import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  assert.match(unitProbe, /node --test src\/cli\/\*\.test\.mjs/);
});
