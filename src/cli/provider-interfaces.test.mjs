import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { workItemMutationOperations, workItemMutationResultStatuses } from "../../build/src/lib/work-item-mutations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readSource(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/** Extract a named function's body from TS source text, from its `function <name>(` declaration
 * up to (but not including) the next top-level `function ` declaration. Anti-drift tests below
 * use this to scope literal extraction to the ONE function that actually emits a given
 * vocabulary, instead of matching the same literal shape across unrelated functions in the same
 * file (e.g. `classify()` and `classifyRevisionFreshness()` both emit a `"stale"` classification
 * literal, for different, unrelated reasons). */
function extractFunctionBody(source, functionName) {
  const startMatch = source.match(new RegExp(`\\n(?:export )?function ${functionName}\\(`));
  assert.ok(startMatch, `expected to find "function ${functionName}(" in the source`);
  const start = startMatch.index;
  const rest = source.slice(start + 1);
  const nextFunction = rest.match(/\n(?:export )?function \w+\(/);
  const end = nextFunction ? start + 1 + nextFunction.index : source.length;
  return source.slice(start, end);
}

// ─── WorkItemProvider: WorkItemReadinessClassification must stay aligned with
// pull-work-provider.ts's classify() ────────────────────────────────────────

/** Extracts every `classification: <expr>` value from a function body, including string
 * literals hidden inside a ternary (e.g. `classification: stale ? "stale" : "drifted"` — a plain
 * `classification: "word"` regex would miss the ternary's branches entirely). */
function emittedClassifications(body) {
  const exprs = [...body.matchAll(/classification:\s*([^,\n]+)/g)].map((m) => m[1]);
  return new Set(exprs.flatMap((expr) => [...expr.matchAll(/"([a-z_-]+)"/g)].map((mm) => mm[1])));
}

test("WorkItemReadinessClassification (provider-interfaces.ts) matches the literal classification values pull-work-provider.ts's classify() actually emits", () => {
  const body = extractFunctionBody(readSource("src/cli/pull-work-provider.ts"), "classify");
  const emitted = emittedClassifications(body);
  // Mirrors provider-interfaces.ts's `WorkItemReadinessClassification` union — update BOTH
  // together if pull-work-provider.ts's classify() ever changes its emitted vocabulary.
  const declared = new Set(["ready", "blocked", "in_progress", "stale", "related-only"]);
  assert.deepEqual(emitted, declared, "classify()'s emitted classification literals drifted from WorkItemReadinessClassification");
});

test("WorkItemRevisionFreshnessClassification (provider-interfaces.ts) matches the literal classification values pull-work-provider.ts's classifyRevisionFreshness() actually emits", () => {
  const body = extractFunctionBody(readSource("src/cli/pull-work-provider.ts"), "classifyRevisionFreshness");
  const emitted = emittedClassifications(body);
  // Mirrors provider-interfaces.ts's `WorkItemRevisionFreshnessClassification` union.
  const declared = new Set(["not_verified", "fresh", "stale", "drifted"]);
  assert.deepEqual(emitted, declared, "classifyRevisionFreshness()'s emitted classification literals drifted from WorkItemRevisionFreshnessClassification");
});

// ─── AssignmentProvider: method surface must stay aligned with the LOCAL-FILE subset of
// assignment-provider.ts's CLI subcommand dispatch ──────────────────────────

test("AssignmentProvider's method names (provider-interfaces.ts) match assignment-provider.ts main()'s local-file subcommand surface", () => {
  const source = readSource("src/cli/assignment-provider.ts");
  const mainBody = extractFunctionBody(source, "main");
  const allSubcommands = new Set([...mainBody.matchAll(/command === "([a-z-]+)"/g)].map((m) => m[1]));
  // The CLI also exposes a GitHub "render, don't execute" surface (render-claim/render-release/
  // render-supersede) that AssignmentProvider's provider-neutral interface deliberately does not
  // cover — see provider-interfaces.ts's AssignmentProvider doc comments and this file's header
  // note on GitHub adapters not being proven here.
  const githubRenderOnly = new Set(["render-claim", "render-release", "render-supersede"]);
  const localFileSubcommands = new Set([...allSubcommands].filter((name) => !githubRenderOnly.has(name)));
  // Mirrors provider-interfaces.ts's `AssignmentProvider` interface method names, verbatim from
  // ADR 0021 §2.
  const declaredMethods = new Set(["claim", "release", "supersede", "status", "list"]);
  assert.deepEqual(localFileSubcommands, declaredMethods, "AssignmentProvider's method surface drifted from assignment-provider.ts's local-file CLI subcommand surface");
  // Sanity: the CLI's GitHub render subcommands are still exactly the three named above (catches
  // a NEW render-* subcommand landing without anyone revisiting this interface's scope note).
  const renderSubcommands = new Set([...allSubcommands].filter((name) => name.startsWith("render-")));
  assert.deepEqual(renderSubcommands, githubRenderOnly);
});

// ─── WorkItemMutationProvider: the single provider-neutral mutate() verb intentionally abstracts
// over the CLI's render/apply split (see provider-interfaces.ts's doc comment) — the mechanically
// checkable invariant here is the OPERATION and RESULT-STATUS vocabulary, which mutate()'s
// request/result types are typed against, plus the CLI's own subcommand surface not silently
// growing a fourth verb this interface would then need to account for. ─────

test("work-item-mutation-provider.ts main()'s subcommand surface is exactly {render, apply, status} — WorkItemMutationProvider.mutate() abstracts over render+apply only", () => {
  const source = readSource("src/cli/work-item-mutation-provider.ts");
  const mainBody = extractFunctionBody(source, "main");
  const cases = new Set([...mainBody.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
  assert.deepEqual(cases, new Set(["render", "apply", "status"]));
});

test("workItemMutationOperations/workItemMutationResultStatuses (already-exported #776 vocabulary) match WorkItemMutationProvider.mutate()'s documented request/result vocabulary", () => {
  assert.deepEqual([...workItemMutationOperations], ["status_transition", "field_update", "comment"]);
  assert.deepEqual([...workItemMutationResultStatuses], ["rendered", "applied", "conflict", "rejected", "not_verified"]);
});
