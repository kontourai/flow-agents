import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { workItemMutationOperations, workItemMutationResultStatuses } from "../../build/src/lib/work-item-mutations.js";
import { workItemReadinessClassifications, referenceAdapterFreshnessDiagnostics } from "../../build/src/cli/pull-work-provider.js";
// Also import from the package's own root entry (self-reference resolution via package.json
// "name" + "exports"), mirroring work-item-vocabulary.test.mjs's guard against the src/index.ts
// re-export silently drifting from the internal module (#775 precedent).
import {
  workItemReadinessClassifications as workItemReadinessClassificationsFromPackageRoot,
  referenceAdapterFreshnessDiagnostics as referenceAdapterFreshnessDiagnosticsFromPackageRoot,
} from "@kontourai/flow-agents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readSource(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/** Extract a named function's body from TS source text, from its `function <name>(` declaration
 * up to (but not including) the next top-level `function ` declaration. Used below ONLY for the
 * dispatch-surface checks, where no cheaper runtime-value alternative exists (a CLI's `main()`
 * subcommand switch has no natural exported array the way a classification vocabulary does) — see
 * #777 review finding 5. LIMITATION: this is a source-text heuristic, not a semantic parse; it
 * assumes each top-level function starts at column 0 with `function `/`export function ` and does
 * not handle nested/inner `function` declarations reusing that exact prefix. */
function extractFunctionBody(source, functionName) {
  const startMatch = source.match(new RegExp(`\\n(?:export )?function ${functionName}\\(`));
  assert.ok(startMatch, `expected to find "function ${functionName}(" in the source`);
  const start = startMatch.index;
  const rest = source.slice(start + 1);
  const nextFunction = rest.match(/\n(?:export )?function \w+\(/);
  const end = nextFunction ? start + 1 + nextFunction.index : source.length;
  return source.slice(start, end);
}

// ─── WorkItemProvider: WorkItemReadinessClassification / ReferenceAdapterFreshnessDiagnostic
// (provider-interfaces.ts) derive their TYPE directly from pull-work-provider.ts's own EXPORTED
// RUNTIME const arrays (#777 review finding 5) — `(typeof workItemReadinessClassifications)
// [number]`, not a hand-copied string-literal union. That derivation is a compile-time guarantee
// (gated by `npm run typecheck`), stronger than any test could assert. What a test CAN usefully
// assert is that `classify()`/`classifyRevisionFreshness()` actually reference those SAME
// constants (not just a coincidentally-matching parallel array) and that the constants' current
// values are the ones this codebase intends. ──────────────────────────────

test("classify() and classifyRevisionFreshness() (pull-work-provider.ts) reference the exported workItemReadinessClassifications/referenceAdapterFreshnessDiagnostics consts by name, not parallel literals", () => {
  const source = readSource("src/cli/pull-work-provider.ts");
  const classifyBody = extractFunctionBody(source, "classify");
  const classifyFreshnessBody = extractFunctionBody(source, "classifyRevisionFreshness");
  // Every classification value classify() returns must be one of the destructured
  // READINESS_* names bound from workItemReadinessClassifications, never a raw string literal
  // (a raw literal would silently NOT update if the array's values ever changed).
  assert.match(classifyBody, /classification: READINESS_[A-Z_]+/, "classify() must return a classification via a READINESS_* const, not a raw string literal");
  assert.doesNotMatch(classifyBody, /classification:\s*"[a-z_-]+"/, "classify() must not return a raw string-literal classification (bypasses workItemReadinessClassifications)");
  assert.match(classifyFreshnessBody, /classification: FRESHNESS_[A-Z_]+/, "classifyRevisionFreshness() must return a classification via a FRESHNESS_* const, not a raw string literal");
  assert.doesNotMatch(classifyFreshnessBody, /classification:\s*"[a-z_-]+"/, "classifyRevisionFreshness() must not return a raw string-literal classification (bypasses referenceAdapterFreshnessDiagnostics)");
});

test("workItemReadinessClassifications (pull-work-provider.ts) is the vocabulary this codebase currently intends", () => {
  assert.deepEqual([...workItemReadinessClassifications], ["ready", "blocked", "in_progress", "stale", "related-only"]);
});

test("referenceAdapterFreshnessDiagnostics (pull-work-provider.ts) is the vocabulary this codebase currently intends — also the contract's NORMATIVE revision-freshness vocabulary since #818 narrowed work-item-contract.md to match (retiring the unemitted five-value WorkItemDriftOutcome from #777 review finding 2)", () => {
  assert.deepEqual([...referenceAdapterFreshnessDiagnostics], ["not_verified", "fresh", "stale", "drifted"]);
});

test("workItemReadinessClassifications/referenceAdapterFreshnessDiagnostics exported from the package root entry match the internal module (#775 pattern)", () => {
  assert.deepEqual([...workItemReadinessClassificationsFromPackageRoot], [...workItemReadinessClassifications]);
  assert.deepEqual([...referenceAdapterFreshnessDiagnosticsFromPackageRoot], [...referenceAdapterFreshnessDiagnostics]);
});

// ─── AssignmentProvider: method surface must stay aligned with the LOCAL-FILE subset of
// assignment-provider.ts's CLI subcommand dispatch. LIMITATION (#777 review finding 5): this
// dispatch-surface check has no cheaper runtime-value alternative (unlike the classification
// vocabularies above) — assignment-provider.ts's main() switch has no natural exported array of
// its own subcommand names, so this remains a source-text heuristic via extractFunctionBody()
// (see that function's own doc comment for its limitations). It only checks METHOD NAMES, not the
// void-vs-record return-shape distinction between AssignmentProvider and LocalAssignmentProviderExt
// (#777 review finding 1) — that distinction is proven behaviorally instead, in
// local-file-provider-adapters.test.mjs. ─────────────────────────────────

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
  // ADR 0021 §2 (method NAMES only — see this section's header note on return-shape coverage).
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
