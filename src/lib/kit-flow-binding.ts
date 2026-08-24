/**
 * kit-flow-binding.ts — the DECLARING KIT's own answers to the questions the canonical run
 * runtime must ask before it can bind a flow (#1316).
 *
 * #1315 removed core's enumeration of flow identifiers at `workflow start`: existence and
 * conformance became declaration-derived. What it could NOT remove was the run adapter's
 * dependence on ONE kit — `flowRelativePath` returned a hardcoded builder path, and
 * `expectedGateProducer` loaded the packaged builder manifest for every flow — so the only
 * flows that could actually RUN were the two that kit ships, and #1315 closed the resulting
 * half-start by refusing everything else.
 *
 * This module is the derivation that replaces those constants. Three answers, all taken from
 * the manifest of the kit that DECLARES the flow, and every one of them fail-closed:
 *
 *   1. WHERE THE DEFINITION LIVES — `KitFlowBinding.flowRelativePath`, from the declaring kit's
 *      `kit.json` `flows[]` entry, not from a constant naming one kit's file.
 *   2. WHO PRODUCES A GATE'S EVIDENCE — `resolveKitGateProducer`, from the declaring kit's
 *      `flow_step_actions` / `skill_roles`, not from one packaged manifest.
 *   3. WHETHER THE ADAPTER CAN BIND THE FLOW AT ALL — `kitFlowRunBindingIssues`: the flow is
 *      bindable exactly when its declaring kit supplies every binding the adapter needs. This
 *      is what turns `CANONICAL_RUN_FLOW_IDS` from a hardcoded pair into a derivation. A flow
 *      missing a binding is REFUSED with the missing binding named — never half-started.
 *
 * NO KIT IDENTIFIER APPEARS IN THIS FILE. That is the point: every rule here is stated in terms
 * of "the kit directory the manifest lives in", so a kit that ships a gate-set variant becomes
 * runnable with no core change — which is what #1280's ablation needs.
 *
 * ─── Declaration ownership ──────────────────────────────────────────────────────────────────
 * The ownership and path-agreement rules are the SAME ones #1315 applied when it derived the
 * startable set (`kitManifestFlowIds` in flow-resolver.ts), restated here because they must
 * hold for the RUN binding too — a start that validates one kit's bytes while the run binds
 * another's is the drift #1315 exists to prevent:
 *
 *   OWNERSHIP  — a manifest may only declare ids namespaced to the DIRECTORY it lives in, and a
 *                manifest whose own `id` disagrees with that directory is refused wholesale
 *                (its identity claim is the thing under doubt).
 *   PATH AGREEMENT — `flows[].path`, when present, must name the exact file canonical resolution
 *                will read for that id. A declaration pointing elsewhere is refused rather than
 *                followed: it is either wrong, or trying to authorize an id whose bytes live
 *                somewhere the resolver will never look.
 *
 * ─── What is NOT derived here (disclosed, not implied) ──────────────────────────────────────
 *   - DIGEST COVERAGE. A binding resolved in the executing PACKAGE's tree is covered by the
 *     package's own integrity. A binding resolved in a project's `kits/` tree is ordinary
 *     tracked repo content: nothing in this module proves those bytes were reviewed. What binds
 *     them is the run record — `startBuilderFlowRun` pins the resolved definition and every
 *     later load re-derives it and asserts deep equality, so the bytes that started a run are
 *     the bytes every later consumer is judged against. Runtime artifact storage (the area the
 *     runtime itself writes) is excluded outright as a kit source, so an agent cannot author a
 *     kit into the runtime's own scratch space and have it become runnable.
 *   - WHETHER A PRODUCER'S EVIDENCE IS ANY GOOD. This resolves WHICH producer owns an
 *     expectation. Whether what it produced satisfies the gate is the gate's own question.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The identifier shape `resolveFlowFilePath` actually enforces on both parts of a flow id. */
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/** Every packaged/tracked kit tree lives under this directory name, one level below its root. */
const KITS_DIR = "kits";

export interface KitFlowBinding {
  /** The declared flow id, `<kit>.<flow>`. */
  flowId: string;
  /** The kit DIRECTORY name the declaration is namespaced to — the only kit identity that counts. */
  kitId: string;
  flowName: string;
  /** Absolute, canonical root containing the `kits/` tree this binding was resolved in. */
  sourceRoot: string;
  /** Absolute, canonical `<sourceRoot>/kits`. */
  kitsRoot: string;
  /** Absolute path of the declaring kit's manifest. */
  manifestPath: string;
  /** The declaring kit's parsed manifest — the producer-binding surface for this flow. */
  manifest: Record<string, unknown>;
  /**
   * `kits/<kit>/<declared path>`, POSIX-relative to `sourceRoot`. This is what the run adapter's
   * `flowRelativePath` constant used to hardcode for one kit.
   */
  flowRelativePath: string;
  /** Absolute, canonical path of the flow definition file. */
  definitionPath: string;
}

/** `<kit>.<flow>` split, plus the SLUG_RE contract the resolver enforces on both parts. */
export function kitFlowIdParts(flowId: string): { kitId: string; flowName: string } | null {
  if (typeof flowId !== "string" || !flowId) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null;
  const kitId = flowId.slice(0, dotIdx);
  const flowName = flowId.slice(dotIdx + 1);
  if (!SLUG_RE.test(kitId) || !SLUG_RE.test(flowName)) return null;
  return { kitId, flowName };
}

/**
 * The roots that may contain a `kits/` tree, in binding-resolution order.
 *
 * PACKAGED FIRST, deliberately. The canonical run runtime has always bound SHIPPED bytes
 * (`loadShippedBuilderFlowDefinition` resolved against the package root and never consulted the
 * project's `kits/`). Keeping the package first means a project-local kit can ADD a runnable
 * flow but can never SHADOW one the package ships — so widening the adapter cannot change what
 * an already-packaged flow binds to, in any layout.
 *
 * Roots are canonicalized and de-duplicated: in the package's own repo the two are the same
 * tree, and a binding must never be reported twice from one directory.
 */
export function kitFlowSourceRoots(packageRoot: string, projectRoot?: string): string[] {
  const roots: string[] = [];
  for (const candidate of [packageRoot, projectRoot]) {
    if (!candidate) continue;
    const canonical = canonicalPathOrNull(candidate);
    if (!canonical || roots.includes(canonical)) continue;
    roots.push(canonical);
  }
  return roots;
}

/**
 * The canonical `<root>/kits` directory, or null when it cannot serve as a kit source.
 *
 * Refused when the resolved kits root escapes its own root (a symlink out of the tree), when it
 * is not a directory, or when it lands inside runtime artifact storage. Returns the REALPATH, so
 * every later containment comparison is against a boundary the tree owner controls rather than
 * one a symlink under test chose — the #1315 review FIX-1 rule, applied to the run binding.
 *
 * MERGE NOTE (#1315): that branch adds an equivalent private `canonicalKitsRoot` to
 * flow-resolver.ts, with the same three refusals plus its `isWithinRuntimeArtifactRoot`
 * derivation of the runtime-storage rule. On merge, export that one and delete this: the two
 * must never be able to disagree about what counts as a kit source.
 */
export function resolveKitsRoot(root: string): string | null {
  const realRoot = canonicalPathOrNull(root);
  if (!realRoot) return null;
  const realKitsRoot = canonicalPathOrNull(path.join(realRoot, KITS_DIR));
  if (!realKitsRoot) return null;
  if (!realKitsRoot.startsWith(realRoot + path.sep)) return null;
  try {
    if (!fs.statSync(realKitsRoot).isDirectory()) return null;
  } catch {
    return null;
  }
  return isWithinRuntimeArtifactStorage(realKitsRoot) ? null : realKitsRoot;
}

/**
 * Resolve the binding for `flowId` from the first source root whose kit tree DECLARES it.
 *
 * Every step fails closed: an unparseable id, a kits root that is not a usable kit source, a
 * manifest that cannot be read or misnames its own kit, a `flows[]` list that does not declare
 * this id, a declared path that disagrees with canonical resolution, or a definition file that
 * does not exist or resolves outside the kit tree — all yield null, never a partial binding.
 */
export function resolveKitFlowBinding(flowId: string, sourceRoots: readonly string[]): KitFlowBinding | null {
  const parts = kitFlowIdParts(flowId);
  if (!parts) return null;
  for (const root of sourceRoots) {
    const kitsRoot = resolveKitsRoot(root);
    if (!kitsRoot) continue;
    const binding = bindingInKitsRoot(flowId, parts, root, kitsRoot);
    if (binding) return binding;
  }
  return null;
}

function bindingInKitsRoot(
  flowId: string,
  parts: { kitId: string; flowName: string },
  sourceRoot: string,
  kitsRoot: string,
): KitFlowBinding | null {
  const kitDir = path.join(kitsRoot, parts.kitId);
  const manifestPath = path.join(kitDir, "kit.json");
  const manifest = readJsonObject(manifestPath);
  if (!manifest) return null;
  // OWNERSHIP: a manifest that misnames its own kit is refused wholesale.
  if (manifest["id"] !== undefined && manifest["id"] !== parts.kitId) return null;
  const declaredPath = declaredFlowPath(manifest, parts);
  if (declaredPath === null) return null;
  // PATH AGREEMENT: the declared path must name the file canonical resolution reads.
  const canonicalRelative = path.join("flows", `${parts.flowName}.flow.json`);
  if (path.resolve(kitDir, declaredPath) !== path.join(kitDir, canonicalRelative)) return null;
  const definitionPath = canonicalPathOrNull(path.join(kitDir, declaredPath));
  if (!definitionPath || !definitionPath.startsWith(kitsRoot + path.sep)) return null;
  try {
    if (!fs.statSync(definitionPath).isFile()) return null;
  } catch {
    return null;
  }
  return {
    flowId,
    kitId: parts.kitId,
    flowName: parts.flowName,
    sourceRoot,
    kitsRoot,
    manifestPath,
    manifest,
    flowRelativePath: [KITS_DIR, parts.kitId, declaredPath].join("/"),
    definitionPath,
  };
}

/**
 * The path the manifest declares for `flowId`, or null when the manifest does not declare it.
 *
 * A manifest with no `flows[]` list declares nothing the RUN binding can use. #1315 lets such a
 * kit fall back to enumerating `flows/` for EXISTENCE, because a refusal listing startable flows
 * should list everything a start could resolve. A run binding is a stronger claim — it is the
 * provenance the run record pins — so it requires the kit to have said so in its manifest.
 */
function declaredFlowPath(manifest: Record<string, unknown>, parts: { kitId: string; flowName: string }): string | null {
  const flows = manifest["flows"];
  if (!Array.isArray(flows)) return null;
  const flowId = `${parts.kitId}.${parts.flowName}`;
  for (const entry of flows) {
    if (!isRecord(entry) || entry["id"] !== flowId) continue;
    const declaredPath = entry["path"];
    if (declaredPath === undefined) return path.join("flows", `${parts.flowName}.flow.json`);
    if (typeof declaredPath !== "string" || declaredPath === "" || path.isAbsolute(declaredPath)) return null;
    return declaredPath;
  }
  return null;
}

// ─── Producer bindings ───────────────────────────────────────────────────────────────────────

/**
 * Which producer the DECLARING kit binds to one gate expectation.
 *
 * Three outcomes, because the caller must be able to tell them apart:
 *   - `producer`  — exactly one skill role owns this expectation for this step.
 *   - `operation` — the kit bound the expectation to an external operation. A local gate-claim
 *     writer legitimately cannot satisfy it; that is a declared property of the flow, not a
 *     missing binding, so it must NOT disqualify the flow from having a canonical run.
 *   - `missing`   — no step action, or not exactly one owning role. Fail closed, and `reason`
 *     names which binding is absent so a refusal can quote it.
 */
export type KitGateProducerResolution =
  | { kind: "producer"; skillId: string; artifacts: string[] }
  | { kind: "operation"; operation: string }
  | { kind: "missing"; reason: "no-step-action" | "producer-ambiguous"; owners: number };

export function resolveKitGateProducer(
  manifest: Record<string, unknown>,
  kitId: string,
  flowId: string,
  stepId: string,
  expectationId: string,
): KitGateProducerResolution {
  const actions = Array.isArray(manifest["flow_step_actions"]) ? manifest["flow_step_actions"] as unknown[] : [];
  const action = actions.find((candidate): candidate is Record<string, unknown> =>
    isRecord(candidate) && candidate["flow_id"] === flowId && candidate["step_id"] === stepId);
  if (!action) return { kind: "missing", reason: "no-step-action", owners: 0 };
  const bindings = Array.isArray(action["expectation_bindings"]) ? action["expectation_bindings"] as unknown[] : [];
  const binding = bindings.find((candidate): candidate is Record<string, unknown> =>
    isRecord(candidate) && candidate["expectation_id"] === expectationId);
  if (binding && binding["interface"] === "operation") {
    const operation = typeof binding["operation"] === "string" ? binding["operation"] : "the declared external operation";
    return { kind: "operation", operation };
  }
  const skills = Array.isArray(action["skills"]) ? (action["skills"] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const roles = Array.isArray(manifest["skill_roles"]) ? manifest["skill_roles"] as unknown[] : [];
  // A kit namespaces its skill roles to itself (`<kit>.<skill>`) while a step action names the
  // bare skill. Stripping the DECLARING kit's own prefix is the generic form of the one-kit
  // literal this replaced; a role belonging to no kit namespace is compared verbatim.
  const prefix = `${kitId}.`;
  const owners = roles.filter((role): role is Record<string, unknown> =>
    isRecord(role)
    && typeof role["skill_id"] === "string"
    && Array.isArray(role["step_ids"]) && (role["step_ids"] as unknown[]).includes(stepId)
    && Array.isArray(role["expectation_ids"]) && (role["expectation_ids"] as unknown[]).includes(expectationId)
    && skills.includes((role["skill_id"] as string).startsWith(prefix) ? (role["skill_id"] as string).slice(prefix.length) : role["skill_id"] as string));
  if (owners.length !== 1) return { kind: "missing", reason: "producer-ambiguous", owners: owners.length };
  const owner = owners[0]!;
  const artifacts = (Array.isArray(owner["artifacts"]) ? owner["artifacts"] as unknown[] : [])
    .filter((value): value is string => typeof value === "string" && value !== "ephemeral decision record");
  return { kind: "producer", skillId: owner["skill_id"] as string, artifacts };
}

// ─── Run bindability ─────────────────────────────────────────────────────────────────────────

/**
 * Everything the canonical run runtime needs in order to bind `flowId`, or the list of bindings
 * the declaring kit failed to supply.
 *
 * `issues` is empty exactly when the flow is bindable. This is the derivation that replaces the
 * hardcoded `CANONICAL_RUN_FLOW_IDS` pair: a flow is canonically runnable when — and only
 * when — the kit that declares it supplies a resolvable definition AND a producer binding for
 * every expectation of every gate in that definition. Anything else fails closed, and each
 * issue names the binding that is missing so the refusal can be acted on rather than guessed at.
 *
 * The definition is supplied by the caller rather than read here: the resolver owns composition
 * (`uses_flow`), and re-implementing it would create a second answer to "what does this flow
 * actually contain" — the exact drift class this module exists to remove.
 */
export function kitFlowRunBindingIssues(binding: KitFlowBinding, definition: unknown): string[] {
  const issues: string[] = [];
  const gates = isRecord(definition) && isRecord(definition["gates"]) ? definition["gates"] : {};
  for (const [gateId, gate] of Object.entries(gates)) {
    if (!isRecord(gate)) continue;
    const stepId = gate["step"];
    if (typeof stepId !== "string") continue;
    const expects = Array.isArray(gate["expects"]) ? gate["expects"] : [];
    if (expects.length === 0) continue;
    for (const expect of expects) {
      if (!isRecord(expect) || typeof expect["id"] !== "string") continue;
      const expectationId = expect["id"];
      const resolution = resolveKitGateProducer(binding.manifest, binding.kitId, binding.flowId, stepId, expectationId);
      if (resolution.kind !== "missing") continue;
      issues.push(resolution.reason === "no-step-action"
        ? `gate ${JSON.stringify(gateId)} runs at step ${JSON.stringify(stepId)}, which ${binding.kitId}/kit.json declares no flow_step_actions binding for (needed to satisfy expectation ${JSON.stringify(expectationId)})`
        : `gate ${JSON.stringify(gateId)} expectation ${JSON.stringify(expectationId)} at step ${JSON.stringify(stepId)} resolves ${resolution.owners} producing skill_roles in ${binding.kitId}/kit.json; exactly one is required`);
    }
  }
  return issues;
}

/** Every flow id declared by a kit under `sourceRoots`, in the order the roots are searched. */
export function declaredKitFlowBindings(sourceRoots: readonly string[]): KitFlowBinding[] {
  const bindings: KitFlowBinding[] = [];
  const seen = new Set<string>();
  for (const root of sourceRoots) {
    const kitsRoot = resolveKitsRoot(root);
    if (!kitsRoot) continue;
    for (const kitEntry of listDirents(kitsRoot)) {
      if (!kitEntry.isDirectory() || !SLUG_RE.test(kitEntry.name)) continue;
      const manifest = readJsonObject(path.join(kitsRoot, kitEntry.name, "kit.json"));
      if (!manifest || !Array.isArray(manifest["flows"])) continue;
      for (const entry of manifest["flows"] as unknown[]) {
        if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
        const flowId = entry["id"];
        if (seen.has(flowId)) continue;
        const parts = kitFlowIdParts(flowId);
        if (!parts || parts.kitId !== kitEntry.name) continue;
        const binding = bindingInKitsRoot(flowId, parts, root, kitsRoot);
        if (!binding) continue;
        seen.add(flowId);
        bindings.push(binding);
      }
    }
  }
  return bindings;
}

// ─── Local helpers ───────────────────────────────────────────────────────────────────────────

/**
 * True when `absPath` lies inside the storage the RUNTIME writes session artifacts into, at one
 * of the three positions `declared-artifact-roots.ts` declares: `<root>/.kontourai/flow-agents`,
 * `<root>/.flow-agents`, `<root>/delivery`. A kit authored there is agent scratch space, not a
 * kit source, so it can never become runnable.
 *
 * MERGE NOTE (#1315): that branch adds `isWithinRuntimeArtifactRoot` to
 * declared-artifact-roots.ts — the same three positions, derived from the one list the config
 * hook and the fixture writer already scope themselves to, and additionally honoring
 * `SA_PROTECTED_WORKSPACE_ROOTS`. On merge, import that and delete this: a kit source judged
 * in-bounds here while the hook treats the same path as protected runtime storage is precisely
 * the disagreement that function exists to prevent. `delivery` is intentionally NOT matched
 * here on its name alone — see that function's parent-qualification rule.
 */
function isWithinRuntimeArtifactStorage(absPath: string): boolean {
  let dir = absPath;
  const root = path.parse(dir).root;
  for (let depth = 0; depth < 1024; depth++) {
    const parent = path.dirname(dir);
    const base = path.basename(dir);
    if (base === ".flow-agents") return true;
    if (base === "flow-agents" && path.basename(parent) === ".kontourai") return true;
    if (dir === root || parent === dir) break;
    dir = parent;
  }
  return false;
}

function canonicalPathOrNull(candidate: string): string | null {
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(path.resolve(candidate));
  } catch {
    return null;
  }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
