import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultFlowConfig, previewFlowConfigMerge } from "@kontourai/flow";

import { validateSchemaValue } from "./mini-json-schema.js";
import { execTrustedGitSync, readTrustedGitBlobSync, resolveTrustedLocalGitCommit } from "./trusted-git.js";

export type GoalFitConfig = Readonly<{
  mode: "off" | "warn" | "block";
  max_blocks: number;
  recheck: boolean;
  backstop: "skip" | "off" | "block";
  backstop_timeout_ms: number;
  require_sidecars: boolean;
  require_critique: boolean;
}>;

export type EffectiveFlowAgentsConfigReport = Readonly<{
  core: { state: "default" | "committed" | "invalid"; provenance: Record<string, string>; diagnostics: string[] };
  effective: { goal_fit: GoalFitConfig };
  fail_closed: boolean;
  working_tree_drift: string[];
  rejected_environment_overrides: string[];
  kits: Array<Record<string, unknown>>;
}>;

const CORE_PATH = ".flow-agents/config/core.config.json";
const INSTALL_PATH = ".flow-agents/install.json";
const FLOW_CONFIG_PATH = ".flow/config.json";
const CONFIG_PREFIX = ".flow-agents/config/";
const MAX_CONFIG_BYTES = 64 * 1024;
const DEFAULT_GOAL_FIT: GoalFitConfig = Object.freeze({
  mode: "warn", max_blocks: 3, recheck: false, backstop: "block", backstop_timeout_ms: 120000, require_sidecars: false, require_critique: false,
});
const STRICT_GOAL_FIT: GoalFitConfig = Object.freeze({
  mode: "block", max_blocks: Number.MAX_SAFE_INTEGER, recheck: false, backstop: "block", backstop_timeout_ms: 1, require_sidecars: true, require_critique: true,
});

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function schema(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(packageRoot(), "schemas", name), "utf8")) as Record<string, unknown>;
}

function validateConfig(file: string, value: unknown, schemaName: string): string[] {
  const issues: Array<{ path: string; message: string }> = [];
  validateSchemaValue(file, value, schema(schemaName), "<root>", issues);
  return issues.map((issue) => issue.message);
}

function sha256(value: Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function configPathsAtHead(root: string, commit: string): string[] {
  const raw = String(execTrustedGitSync(root, ["ls-tree", "-r", "--name-only", commit, "--", CONFIG_PREFIX]));
  return raw.split("\n").filter((entry) => entry === CORE_PATH || /^\.flow-agents\/config\/[a-z][a-z0-9-]*\.kit\.config\.json$/u.test(entry));
}

/** A bounded, lstat-only marker walk keeps hostile Git state from masquerading as no repository. */
function hasGitMarkerOrAncestor(root: string): boolean {
  let cursor = path.resolve(root);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      fs.lstatSync(path.join(cursor, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return true;
}

/** Read an optional committed blob, distinguishing confirmed absence from any Git failure. */
function readOptionalCommittedBlob(root: string, commit: string, relativePath: string): Buffer | undefined {
  const listed = String(execTrustedGitSync(root, ["ls-tree", "--name-only", commit, "--", relativePath])).trim();
  if (!listed) return undefined;
  if (listed.split("\n").some((entry) => entry !== relativePath)) throw new Error(`unexpected committed path while resolving ${relativePath}`);
  return readTrustedGitBlobSync(root, commit, relativePath, MAX_CONFIG_BYTES);
}

/**
 * The runtime's init-written activation record is deliberately local state, not
 * committed policy. Read it defensively and use it only to decide whether a
 * committed Kit proposal may be previewed; it can never activate a Kit.
 */
function activeKitIdsFromInstallRecord(root: string): { activeKitIds: Set<string>; diagnostic?: string } {
  const recordPath = path.join(root, INSTALL_PATH);
  try {
    const before = fs.lstatSync(recordPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONFIG_BYTES) throw new Error("local install record is not a bounded regular file");
    const fd = fs.openSync(recordPath, "r");
    let bytes: Buffer;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("local install record changed while opening");
      bytes = Buffer.alloc(opened.size);
      if (fs.readSync(fd, bytes, 0, opened.size, 0) !== opened.size) throw new Error("could not read local install record");
    } finally { fs.closeSync(fd); }
    const after = fs.lstatSync(recordPath);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) throw new Error("local install record changed while reading");
    const value = JSON.parse(bytes.toString("utf8")) as { active_kit_ids?: unknown };
    if (!value || typeof value !== "object" || !Array.isArray(value.active_kit_ids)
      || value.active_kit_ids.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(id))
      || new Set(value.active_kit_ids).size !== value.active_kit_ids.length) {
      throw new Error("committed install record has invalid active_kit_ids");
    }
    return { activeKitIds: new Set(value.active_kit_ids) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { activeKitIds: new Set() };
    return { activeKitIds: new Set(), diagnostic: (error as Error).message || "could not read committed install record" };
  }
}

function committedFlowConfig(root: string, commit: string): { config?: Record<string, unknown>; diagnostic?: string } {
  try {
    const bytes = readOptionalCommittedBlob(root, commit, FLOW_CONFIG_PATH);
    // Flow's default is used only after trusted Git has confirmed the local
    // authority file is absent from the immutable commit.
    if (!bytes) return { config: defaultFlowConfig() };
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("committed Flow config must be an object");
    return { config: value as Record<string, unknown> };
  } catch (error) {
    return { diagnostic: (error as Error).message || "could not read committed Flow config" };
  }
}

function driftPaths(root: string, committed: Map<string, Buffer>): string[] {
  const candidate = new Set<string>(committed.keys());
  const directory = path.join(root, ".flow-agents", "config");
  try {
    if (fs.lstatSync(directory).isDirectory()) {
      for (const entry of fs.readdirSync(directory)) {
        const rel = `${CONFIG_PREFIX}${entry}`;
        if (entry === "core.config.json" || /^[a-z][a-z0-9-]*\.kit\.config\.json$/u.test(entry)) candidate.add(rel);
      }
    }
  } catch { /* absent config is normal */ }
  const out: string[] = [];
  for (const rel of candidate) {
    try {
      const stat = fs.lstatSync(path.join(root, rel));
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) { out.push(rel); continue; }
      const bytes = fs.readFileSync(path.join(root, rel));
      if (!committed.get(rel)?.equals(bytes)) out.push(rel);
    } catch {
      if (committed.has(rel)) out.push(rel);
    }
  }
  return out.sort();
}

function isProduction(environment: NodeJS.ProcessEnv): boolean {
  return ["production", "prod"].includes(String(environment.NODE_ENV ?? "").toLowerCase());
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^true$/iu.test(value)) return true;
  if (/^false$/iu.test(value)) return false;
  return undefined;
}

function applyEnvironment(base: GoalFitConfig, environment: NodeJS.ProcessEnv): { value: GoalFitConfig; rejected: string[] } {
  const proposed: GoalFitConfig = {
    mode: (["off", "warn", "block"] as const).includes(String(environment.FLOW_AGENTS_GOAL_FIT_MODE).toLowerCase() as "off" | "warn" | "block")
      ? String(environment.FLOW_AGENTS_GOAL_FIT_MODE).toLowerCase() as "off" | "warn" | "block"
      : parseBoolean(environment.FLOW_AGENTS_GOAL_FIT_STRICT) ? "block" : base.mode,
    max_blocks: Number.parseInt(environment.FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS ?? "", 10) || base.max_blocks,
    recheck: parseBoolean(environment.FLOW_AGENTS_GOAL_FIT_RECHECK) ?? base.recheck,
    backstop: ({ skip: "skip", off: "off", warn: "off", block: "block" } as const)[String(environment.FLOW_AGENTS_GOAL_FIT_BACKSTOP).toLowerCase()]
      ?? base.backstop,
    backstop_timeout_ms: Number.parseInt(environment.FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS ?? "", 10) || base.backstop_timeout_ms,
    require_sidecars: parseBoolean(environment.FLOW_AGENTS_REQUIRE_SIDECARS) ?? base.require_sidecars,
    require_critique: parseBoolean(environment.FLOW_AGENTS_REQUIRE_CRITIQUE) ?? base.require_critique,
  };
  if (!isProduction(environment)) return { value: proposed, rejected: [] };
  const rejected: string[] = [];
  const modeRank = { off: 0, warn: 1, block: 2 } as const;
  const backstopRank = { skip: 0, off: 1, block: 2 } as const;
  const mode = modeRank[proposed.mode] >= modeRank[base.mode] ? proposed.mode : (rejected.push("FLOW_AGENTS_GOAL_FIT_MODE"), base.mode);
  const max_blocks = proposed.max_blocks >= base.max_blocks ? proposed.max_blocks : (rejected.push("FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS"), base.max_blocks);
  // Recheck executes model-supplied shell text. It is an execution opt-in, not
  // an enforcement tightening, so production environment values cannot enable
  // it over the committed policy floor. Operators can still disable a committed
  // opt-in while diagnosing a production incident.
  const recheck = !base.recheck && proposed.recheck
    ? (rejected.push("FLOW_AGENTS_GOAL_FIT_RECHECK"), false)
    : proposed.recheck;
  const backstop = backstopRank[proposed.backstop] >= backstopRank[base.backstop] ? proposed.backstop : (rejected.push("FLOW_AGENTS_GOAL_FIT_BACKSTOP"), base.backstop);
  const backstop_timeout_ms = proposed.backstop_timeout_ms <= base.backstop_timeout_ms ? proposed.backstop_timeout_ms : (rejected.push("FLOW_AGENTS_GOAL_FIT_BACKSTOP_TIMEOUT_MS"), base.backstop_timeout_ms);
  const require_sidecars = proposed.require_sidecars || !base.require_sidecars ? proposed.require_sidecars : (rejected.push("FLOW_AGENTS_REQUIRE_SIDECARS"), base.require_sidecars);
  const require_critique = proposed.require_critique || !base.require_critique ? proposed.require_critique : (rejected.push("FLOW_AGENTS_REQUIRE_CRITIQUE"), base.require_critique);
  return { value: { mode, max_blocks, recheck, backstop, backstop_timeout_ms, require_sidecars, require_critique }, rejected };
}

/** Inspect committed configuration without treating working-tree bytes as authority. */
export function inspectEffectiveFlowAgentsConfig(root: string, options: { environment?: NodeJS.ProcessEnv } = {}): EffectiveFlowAgentsConfigReport {
  const environment = options.environment ?? process.env;
  let commit: string;
  try { commit = resolveTrustedLocalGitCommit(root, "HEAD"); } catch (error) {
    if (!hasGitMarkerOrAncestor(root)) {
      const environmentResult = applyEnvironment(DEFAULT_GOAL_FIT, environment);
      return { core: { state: "default", provenance: {}, diagnostics: [] }, effective: { goal_fit: environmentResult.value }, fail_closed: false, working_tree_drift: [], rejected_environment_overrides: environmentResult.rejected, kits: [] };
    }
    return { core: { state: "invalid", provenance: {}, diagnostics: [(error as Error).message] }, effective: { goal_fit: STRICT_GOAL_FIT }, fail_closed: true, working_tree_drift: [], rejected_environment_overrides: [], kits: [] };
  }
  const committed = new Map<string, Buffer>();
  const diagnostics: string[] = [];
  try {
    for (const rel of configPathsAtHead(root, commit)) committed.set(rel, readTrustedGitBlobSync(root, commit, rel, MAX_CONFIG_BYTES));
  } catch (error) {
    return { core: { state: "invalid", provenance: { commit }, diagnostics: [(error as Error).message] }, effective: { goal_fit: STRICT_GOAL_FIT }, fail_closed: true, working_tree_drift: [], rejected_environment_overrides: [], kits: [] };
  }
  const coreBytes = committed.get(CORE_PATH);
  let coreState: "default" | "committed" | "invalid" = coreBytes ? "committed" : "default";
  let goalFit = DEFAULT_GOAL_FIT;
  if (coreBytes) {
    try {
      const value = JSON.parse(coreBytes.toString("utf8")) as { goal_fit?: GoalFitConfig };
      const errors = validateConfig(CORE_PATH, value, "flow-agents-core-config.schema.json");
      if (errors.length) { coreState = "invalid"; diagnostics.push(...errors); }
      else goalFit = value.goal_fit!;
    } catch { coreState = "invalid"; diagnostics.push("committed core configuration is not valid JSON"); }
  }
  const activation = activeKitIdsFromInstallRecord(root);
  const flowAuthority = committedFlowConfig(root, commit);
  const kits = [...committed.entries()].filter(([rel]) => rel !== CORE_PATH).map(([rel, bytes]) => {
    try {
      const value = JSON.parse(bytes.toString("utf8")) as { kit_id: string; gate_overrides: Record<string, unknown> };
      const filenameKitId = path.basename(rel, ".kit.config.json");
      if (value.kit_id !== filenameKitId) return { path: rel, state: "invalid", activation: "not-active", diagnostics: ["Kit config filename stem must exactly match kit_id"] };
      const errors = validateConfig(rel, value, "flow-agents-kit-config.schema.json");
      if (errors.length) return { path: rel, state: "invalid", diagnostics: errors };
      if (activation.diagnostic) return { path: rel, state: "invalid", activation: "not-active", diagnostics: [activation.diagnostic] };
      if (!activation.activeKitIds.has(value.kit_id)) return { path: rel, state: "committed", kit_id: value.kit_id, activation: "not-active" };
      if (flowAuthority.diagnostic || !flowAuthority.config) return { path: rel, state: "invalid", activation: "active-proposal-only", diagnostics: [flowAuthority.diagnostic ?? "committed Flow authority is unavailable"] };
      // Per-Kit policy is an envelope around Flow's project-config proposal
      // vocabulary. Previewing it is intentionally non-mutating: this neither
      // installs nor activates a Kit, and it never applies the merged config.
      const flow_merge_preview = previewFlowConfigMerge(flowAuthority.config, {
        schema_version: "0.1",
        gate_overrides: value.gate_overrides,
      }, { mode: "preview", proposalPath: rel });
      return { path: rel, state: "committed", kit_id: value.kit_id, activation: "active-proposal-only", flow_merge_preview };
    } catch (error) { return { path: rel, state: "invalid", diagnostics: [(error as Error).message || "committed Kit configuration is not valid JSON"] }; }
  });
  if (coreState === "invalid" || kits.some((kit) => kit.state === "invalid")) return { core: { state: "invalid", provenance: { commit, path: CORE_PATH, digest: coreBytes ? sha256(coreBytes) : "" }, diagnostics }, effective: { goal_fit: STRICT_GOAL_FIT }, fail_closed: true, working_tree_drift: driftPaths(root, committed), rejected_environment_overrides: [], kits };
  const environmentResult = applyEnvironment(goalFit, environment);
  return { core: { state: coreState, provenance: coreBytes ? { commit, path: CORE_PATH, digest: sha256(coreBytes) } : { commit, path: CORE_PATH }, diagnostics }, effective: { goal_fit: environmentResult.value }, fail_closed: false, working_tree_drift: driftPaths(root, committed), rejected_environment_overrides: environmentResult.rejected, kits };
}
