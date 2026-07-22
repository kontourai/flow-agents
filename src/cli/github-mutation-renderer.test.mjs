import assert from "node:assert/strict";
import test from "node:test";

import { createGithubMutationRenderer } from "../../build/src/cli/github-mutation-renderer.js";
import { renderGithubMutation, parseGithubMutationTarget } from "../../build/src/cli/work-item-mutation-provider.js";
import { WorkItemMutationError, parseWorkItemMutationRequest } from "../../build/src/lib/work-item-mutations.js";
// Also import from the package's own root entry (self-reference resolution via package.json
// "name" + "exports"), mirroring work-item-vocabulary.test.mjs's guard against the src/index.ts
// re-export silently drifting from the internal module (#775 precedent).
import { createGithubMutationRenderer as createGithubMutationRendererFromPackageRoot } from "@kontourai/flow-agents";

const TARGET = { repo: { owner: "kontourai", name: "flow-agents" }, number: 776 };
const MATCHING_REF = { id: "github:kontourai/flow-agents#776", owner: "kontourai", repo: "flow-agents", number: 776 };

function statusRequest(overrides = {}) {
  return parseWorkItemMutationRequest({
    schema_version: "1.0",
    operation: "status_transition",
    work_item_ref: MATCHING_REF,
    base: { status: "in_progress" },
    payload: { to_status: "review" },
    ...overrides,
  });
}

// ─── #777 review finding 4 implementability proof: createGithubMutationRenderer formally
// satisfies WorkItemMutationProvider (the `satisfies WorkItemMutationProvider` annotation in
// github-mutation-renderer.ts is the type-level half, gated by `npm run typecheck`; these tests
// are the behavioral half — proving the SAME provider-neutral interface types both the local-file
// adapter (local-file-provider-adapters.test.mjs) and this GitHub render adapter). ──────────

test("createGithubMutationRenderer: mutate() with a matching observed status renders the same gh argv as calling renderGithubMutation directly", () => {
  const renderer = createGithubMutationRenderer();
  const request = statusRequest();
  const viaInterface = renderer.mutate(request, { observed: { status: "in_progress" }, providerTarget: TARGET });
  const direct = renderGithubMutation(request, { status: "in_progress" }, parseGithubMutationTarget(TARGET));
  assert.deepEqual(viaInterface, direct);
  assert.equal(viaInterface.status, "rendered");
  assert.ok(Array.isArray(viaInterface.gh_commands) && viaInterface.gh_commands.length > 0);
});

test("createGithubMutationRenderer: mutate() never executes gh — it only renders argv (render, don't execute)", () => {
  const renderer = createGithubMutationRenderer();
  const request = statusRequest();
  const result = renderer.mutate(request, { observed: { status: "in_progress" }, providerTarget: TARGET });
  assert.equal(result.status, "rendered");
  for (const argv of result.gh_commands) {
    assert.ok(Array.isArray(argv), "gh_commands entries must be argv arrays, never a shell string");
  }
});

test("createGithubMutationRenderer: mutate() without context.observed returns not_verified for a clobber-risk operation (never a fabricated render)", () => {
  const renderer = createGithubMutationRenderer();
  const result = renderer.mutate(statusRequest(), { providerTarget: TARGET });
  assert.equal(result.status, "not_verified");
  assert.equal(result.gh_commands, undefined);
});

test("createGithubMutationRenderer: mutate() reports conflict (provider wins) when context.observed diverges from the request's declared base", () => {
  const renderer = createGithubMutationRenderer();
  const result = renderer.mutate(statusRequest(), { observed: { status: "blocked" }, providerTarget: TARGET });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflict.observed_value, "blocked");
  assert.equal(result.advisory, true);
});

test("createGithubMutationRenderer: mutate() throws WorkItemMutationError when context.providerTarget is missing or malformed (shape validation, not a rejected result)", () => {
  const renderer = createGithubMutationRenderer();
  assert.throws(() => renderer.mutate(statusRequest(), { observed: { status: "in_progress" } }), WorkItemMutationError);
  assert.throws(() => renderer.mutate(statusRequest(), { observed: { status: "in_progress" }, providerTarget: { repo: { owner: "kontourai" } } }), WorkItemMutationError);
});

test("createGithubMutationRenderer: mutate() with a mismatched providerTarget is a rejected result, not an exception (target redirect guard)", () => {
  const renderer = createGithubMutationRenderer();
  const wrongTarget = { repo: { owner: "kontourai", name: "flow-agents" }, number: 1 };
  const result = renderer.mutate(statusRequest(), { observed: { status: "in_progress" }, providerTarget: wrongTarget });
  assert.equal(result.status, "rejected");
  assert.equal(result.gh_commands, undefined);
});

test("createGithubMutationRenderer: comment mutations render regardless of context.observed (append-only, non-clobbering)", () => {
  const renderer = createGithubMutationRenderer();
  const request = parseWorkItemMutationRequest({
    schema_version: "1.0",
    operation: "comment",
    work_item_ref: MATCHING_REF,
    base: {},
    payload: { body: "hello from the interface" },
  });
  const result = renderer.mutate(request, { providerTarget: TARGET });
  assert.equal(result.status, "rendered");
  assert.equal(result.advisory, undefined);
});

test("createGithubMutationRenderer exported from the package root entry is the same adapter factory (#775 pattern)", () => {
  const renderer = createGithubMutationRendererFromPackageRoot();
  const result = renderer.mutate(statusRequest(), { observed: { status: "in_progress" }, providerTarget: TARGET });
  assert.equal(result.status, "rendered");
});
