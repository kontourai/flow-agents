/**
 * flow-admission.ts — THE rule for admitting a flow id onto a governed surface (#1280, #1316).
 *
 * ─── Why this is one function and not three ─────────────────────────────────────────────────
 *
 * #1315 built this rule for the PUBLIC verb (`workflow start`) and closed its holes by refusing
 * anything the canonical run runtime could not bind. The review found the hole that survives that
 * fix: `workflow start` is not the only door. The installed sidecar is a binary on PATH, and
 *
 *   flow-agents-workflow-sidecar ensure-session --flow-id <anything>
 *   flow-agents-workflow-sidecar advance-state <dir> --flow-definition <anything>
 *
 * reached the same artifacts by a different route. ensure-session wrote session/current artifacts
 * for ANY resolvable flow id and merely skipped the canonical run; advance-state wrote
 * `state.json` and published `active_step_id` — the pointer the Stop hook reads to decide which
 * gate governs the turn — with no canonical run and no satisfied gate. A refusal on one door is
 * a routing suggestion, and "the public verb refuses it" describes the door, not the property.
 *
 * So the rule lives HERE, and every door calls it. The surface label is a parameter because the
 * refusals must name the flag the caller actually typed; nothing else varies.
 *
 * ─── The four questions, and who answers each ───────────────────────────────────────────────
 *
 *  1. EXISTENCE + SOURCE — `declaredKitFlows`: what the installed kits declare, each declaration
 *     BOUND TO THE ROOT THAT MADE IT, walked packaged-first. An unknown flow fails closed naming
 *     the derived list. Core spells no kit name.
 *  2. CONFORMANCE — the resolver's own composition machinery (`resolveEffectiveFlowDefinition`,
 *     so `uses_flow` extensions are judged as they will run), declared-id agreement,
 *     `@kontourai/flow`'s `validateDefinition`, and `flowDefinitionResolverContractIssues`. The
 *     last exists because the base validator is LOOSER than the resolver downstream: it accepts
 *     any non-empty step id while the resolver requires SLUG_RE, so without it a definition can
 *     be admitted, publish a step nothing can resolve, and silently downgrade the Stop hook to
 *     generic `workflow.*` enforcement.
 *  3. RUNNABILITY — `canonicalRunFlowRefusal`, the run adapter's own DERIVED capability: the
 *     declaring kit supplies a resolvable definition and a producer binding for every expectation
 *     of every gate. A flow with no canonical run has no pinned definition digest and no producer
 *     that can satisfy a gate, so a session bound to it can neither progress nor be trusted.
 *  4. SOURCE AGREEMENT — the root that DECLARED the flow must be the root the run BINDS. This is
 *     the question a bare `Set<string>` of ids could not even ask. Without it, a package
 *     declaration authorizes a start whose bytes come from a consumer file the package never
 *     declared: admission validates one file, the run pins another, and every later consumer
 *     rereads a third. See the refusal text for the two shapes this takes.
 *
 * Order matters and is deliberate: conformance is asked BEFORE runnability so a malformed
 * definition is named as malformed rather than as unbindable — the caller can act on the former.
 */
import { validateDefinition } from "@kontourai/flow";
import { canonicalRunFlowRefusal, canonicalRunSourceRoots } from "../builder-flow-run-adapter.js";
import { resolveKitFlowBinding } from "./kit-flow-binding.js";
import { declaredFlowStepIds, declaredKitFlows, flowDefinitionResolverContractIssues, resolveEffectiveFlowDefinition } from "./flow-resolver.js";

/**
 * The refusal for admitting `flow` on `surface`, or null when the flow may be admitted.
 *
 * `surface` is the flag the caller typed, without the flow id — e.g. `"workflow start --flow"` or
 * `"ensure-session --flow-id"`. Every message begins `<surface> <flow> ...` so a reader can see
 * which door refused them and re-run the exact command.
 */
export function flowAdmissionRefusal(flow: string, repoRoot: string, surface: string): string | null {
  const declarations = declaredKitFlows(repoRoot);
  // The FIRST declaration in root order is the authorizing one — a project kit can add a flow but
  // can never shadow a packaged one, matching what the run binding has always done.
  const declaration = declarations.find((candidate) => candidate.flowId === flow);
  if (!declaration) {
    const ids = [...new Set(declarations.map((candidate) => candidate.flowId))].sort();
    return `${surface} ${JSON.stringify(flow)} is not a flow declared by the installed kits; declared flows: ${ids.length > 0 ? ids.join(", ") : "<none>"}`;
  }

  // Resolve the definition FROM THE DECLARING ROOT, and honor the defs-dir override only for a
  // declaration that came from it. A manifest-declared flow is read from its kit tree even when
  // an override is set: otherwise an env var silently redirects the bytes admission judges.
  const definition = resolveEffectiveFlowDefinition(flow, declaration.sourceRoot, { allowOverride: declaration.via === "override" });
  if (!definition) {
    return `${surface} ${flow} is declared by an installed kit but does not resolve to a conforming flow composition`;
  }
  if (definition["id"] !== flow) {
    return `${surface} ${flow} resolved a definition declaring id ${JSON.stringify(String(definition["id"]))}; a kit's declared flow id and its definition must agree`;
  }
  try {
    validateDefinition(definition);
  } catch (error) {
    return `${surface} ${flow} does not conform to the Flow definition contract: ${error instanceof Error ? error.message : String(error)}`;
  }
  // phase_map is judged against the RAW step ids — see `declaredFlowStepIds`. The composed
  // definition prunes terminal sentinels the resolver still resolves.
  const declaredStepIds = declaredFlowStepIds(flow, declaration.sourceRoot, declaration.via === "override");
  const contractIssues = flowDefinitionResolverContractIssues(definition, declaredStepIds ? { declaredStepIds } : {});
  if (contractIssues.length > 0) {
    return `${surface} ${flow} does not satisfy the flow resolver's identifier contract, so its steps would publish but never resolve: ${contractIssues.join("; ")}`;
  }

  // A flow the canonical run runtime cannot bind used to be ADMITTED: sidecars, an active
  // pointer and a continuation advertisement were written, the "no canonical Flow bound" notice
  // was suppressed (a flow id was present), and no run was created. That session cannot progress
  // — gate-claim producers are resolved from the declaring kit's manifest, which has none for it
  // — and cannot be trusted either: with no run record there is no pinned definition digest, so
  // the bytes validated HERE are not bound to the bytes every later consumer rereads from the
  // same path (first-step lookup, gate resolution, the Stop hook). Advertising an active flow
  // session with neither property is a claim nothing derives, so it is refused outright.
  const runRefusal = canonicalRunFlowRefusal(flow, repoRoot);
  if (runRefusal) {
    return `${surface} ${flow} is declared and conforming, but the canonical run runtime cannot bind it, so the session could not record a pinned definition digest or satisfy a gate: ${runRefusal}`;
  }

  // The run binding exists (the refusal above is null), so this cannot be null. Compare the root
  // that DECLARED the flow with the root whose bytes the run will PIN.
  const binding = resolveKitFlowBinding(flow, canonicalRunSourceRoots(repoRoot));
  if (!binding) {
    return `${surface} ${flow} has a canonical run capability but no resolvable binding; refusing rather than admitting an unpinned session`;
  }
  if (declaration.via === "override") {
    return `${surface} ${flow} was declared by FLOW_AGENTS_FLOW_DEFS_DIR (${declaration.sourceRoot}) while the canonical run would pin ${binding.definitionPath}; the bytes admission validates must be the bytes the run pins, and an env var is not provenance`;
  }
  if (declaration.sourceRoot !== binding.sourceRoot) {
    return `${surface} ${flow} is declared under ${declaration.sourceRoot} (${declaration.via}) but the canonical run would pin the copy under ${binding.sourceRoot} (${binding.flowRelativePath}); admission and the run must judge the same bytes, so a declaration in one tree may not authorize a definition in another`;
  }
  return null;
}
