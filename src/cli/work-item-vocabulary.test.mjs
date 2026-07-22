import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { workItemStatuses } from "../../build/src/lib/work-item-vocabulary.js";
// Also import from the package's own root entry (self-reference resolution via package.json
// "name" + "exports"), not just the internal built module above, so a dropped re-export in
// src/index.ts (the actual public surface hosts consume) fails this test too.
import { workItemStatuses as workItemStatusesFromPackageRoot } from "@kontourai/flow-agents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "..", "..", "schemas", "backlog-provider-settings.schema.json");

// `triage` is a board pre-readiness intake sentinel (docs/decisions/backlog-readiness-source.md),
// not a workflow-facing lifecycle status — it is deliberately excluded from `workItemStatuses`.
const NON_LIFECYCLE_SENTINELS = new Set(["triage"]);

function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

// Anti-drift guard (#775): `workItemStatuses` is exported once from the library entry so hosts
// don't hand-mirror the vocabulary. This test proves that export cannot silently drift from the
// JSON-Schema enums it is supposed to summarize.
test("workItemStatuses equals the union of the backlog-provider-settings schema status enums (minus the triage sentinel)", () => {
  const schema = loadSchema();
  const filters = schema.$defs.selection.properties.filters.properties;
  const wipPolicy = schema.$defs.selection.properties.wip_policy.properties;

  const readyStatuses = filters.ready_statuses.items.enum;
  const excludeStatuses = filters.exclude_statuses.items.enum;
  const activeStatuses = wipPolicy.active_statuses.items.enum;

  assert.ok(readyStatuses?.length, "expected selection.filters.ready_statuses enum in the schema");
  assert.ok(excludeStatuses?.length, "expected selection.filters.exclude_statuses enum in the schema");
  assert.ok(activeStatuses?.length, "expected selection.wip_policy.active_statuses enum in the schema");

  const schemaUnion = new Set([...readyStatuses, ...excludeStatuses, ...activeStatuses]);
  for (const sentinel of NON_LIFECYCLE_SENTINELS) {
    schemaUnion.delete(sentinel);
  }

  const exported = new Set(workItemStatuses);

  assert.deepEqual(
    [...exported].sort(),
    [...schemaUnion].sort(),
    "workItemStatuses must equal (ready_statuses ∪ exclude_statuses ∪ active_statuses) minus the documented triage sentinel; update both together if the vocabulary changes"
  );

  assert.equal(exported.size, workItemStatuses.length, "workItemStatuses must not contain duplicates");
});

test("workItemStatuses matches the neutral lifecycle order in context/contracts/work-item-contract.md", () => {
  assert.deepEqual(
    workItemStatuses,
    ["todo", "ready", "in_progress", "blocked", "review", "verification", "done"]
  );
});

// Guards against the internal-module re-export and the package's public root entry silently
// diverging (e.g. someone edits src/lib/work-item-vocabulary.ts without updating the src/index.ts
// re-export, or vice versa).
test("workItemStatuses exported from the package root entry (@kontourai/flow-agents) matches the internal module", () => {
  assert.deepEqual([...workItemStatusesFromPackageRoot], [...workItemStatuses]);
});

// Anti-drift guard (#775 item 4): consumers should be able to resolve the shipped schemas via the
// package's `./schemas/*` exports subpath instead of require.resolve path math. This proves the
// subpath actually resolves (via Node's self-reference resolution against this package's own
// package.json "exports") to the same schema file used above, and that the resolved file is valid,
// parseable JSON — not just that the exports map entry exists in package.json.
test("the ./schemas/*.json exports subpath resolves to a readable, valid schema file", () => {
  const resolvedUrl = import.meta.resolve("@kontourai/flow-agents/schemas/backlog-provider-settings.schema.json");
  const resolvedPath = fileURLToPath(resolvedUrl);

  assert.equal(realpathSync(resolvedPath), realpathSync(SCHEMA_PATH));

  const schema = JSON.parse(readFileSync(resolvedPath, "utf8"));
  assert.equal(schema.title, "Flow Agents Backlog Provider Settings");
});
