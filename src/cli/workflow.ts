import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { loadBuilderBuildRun } from "../builder-flow-run-adapter.js";
import { flowAgentsPackageRoot, flowAgentsPackageVersion } from "../lib/package-version.js";
import { pinnedFlowAgentsCommand } from "../lib/pinned-cli-command.js";
import { defaultArtifactRootForRead, flowAgentsArtifactRoot } from "../lib/local-artifact-root.js";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { main as builderRun } from "./builder-run.js";
import { currentWorkflowSessionDir, main as workflowWriter, WORKFLOW_WRITER_CONTRACT_VERSION } from "./workflow-sidecar.js";

type JsonRecord = Record<string, unknown>;

export const WORKFLOW_CONTRACT_VERSION = "1.0";
const PACKAGE_ROOT = flowAgentsPackageRoot();
const REQUIRE = createRequire(import.meta.url);
const PACKAGE_METADATA = readJsonFile(path.join(PACKAGE_ROOT, "package.json"), "Flow Agents package metadata");
const CLI_VERSION = flowAgentsPackageVersion();
const PUBLIC_VERBS = ["start", "status", "evidence", "pause", "resume", "release", "cancel", "archive", "doctor"] as const;

function usage(): void {
  console.log(`Usage: flow-agents workflow <verb> [options]

Public workflow verbs:
  start               Start or resume a workflow for a Work Item.
  status              Show the current canonical run and projected next action.
  evidence            Record evidence for the current Flow gate and synchronize it.
  pause               Pause the current run as its assignment actor.
  resume              Resume the current paused run as its assignment actor.
  release             Release the current assignment without canceling the run.
  cancel              Cancel through a signed user/operator authorization record.
  archive             Archive a terminal session through a signed authorization record.
  doctor              Report CLI, install, Kit, Flow, and artifact compatibility.

Use the isolated exact-package command emitted by workflow status and doctor in automation.`);
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const verb = parsed.positionals[0];
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    usage();
    return 0;
  }
  if (!(PUBLIC_VERBS as readonly string[]).includes(verb)) {
    console.error(`Unknown workflow verb: ${verb}`);
    usage();
    return 64;
  }
  if (verb === "start") return start(argv.slice(1));
  if (verb === "doctor") return doctor(argv.slice(1));

  const sessionDir = resolveSessionDir(parsed.flags);
  if (verb === "status") return status(sessionDir, flagBool(parsed.flags, "json"));
  if (verb === "evidence") return evidence(sessionDir, argv.slice(1), flagBool(parsed.flags, "json"));

  const forwarded = stripPublicFlags(argv.slice(1), new Set(["artifact-root", "session-dir", "json"]));
  if (verb === "release" && !flagString(parsed.flags, "reason")) throw new Error("workflow release requires --reason <text>");
  return builderRun([verb === "release" ? "release-assignment" : verb, "--session-dir", sessionDir, ...forwarded]);
}

async function start(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["flow", "work-item", "task-slug", "artifact-root", "source-request", "summary", "title", "criterion"]), "workflow start");
  const flow = flagString(parsed.flags, "flow", "builder.build")!;
  if (flow !== "builder.build") throw new Error("workflow start currently supports only --flow builder.build");
  const workItem = flagString(parsed.flags, "work-item");
  if (!workItem) throw new Error("workflow start requires --work-item <owner/repo#id>");
  const artifactRoot = path.resolve(flagString(parsed.flags, "artifact-root", flowAgentsArtifactRoot())!);
  const taskSlug = flagString(parsed.flags, "task-slug");
  if (workItem.startsWith("local:")) {
    const localSlug = workItem.slice("local:".length);
    if (!taskSlug || taskSlug !== localSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(localSlug)) {
      throw new Error("local Work Item retries require the exact existing --task-slug binding");
    }
    const sessionDir = validateCanonicalSessionDir(path.join(artifactRoot, taskSlug));
    const localRecord = readJsonFile(path.join(sessionDir, "work-item.json"), "local Work Item binding");
    if (localRecord.id !== taskSlug || (localRecord.source_provider as JsonRecord | undefined)?.kind !== "local") {
      throw new Error("local Work Item retry does not match the existing session binding");
    }
  } else if (taskSlug) {
    throw new Error("--task-slug is reserved for an existing local Work Item retry");
  }
  const sourceRequest = flagString(parsed.flags, "source-request", `Start ${flow} for ${workItem}`)!;
  const summary = flagString(parsed.flags, "summary", `Deliver ${workItem} through ${flow}.`)!;
  const forwarded = keepFlags(argv, new Set(["title", "criterion"]));
  return workflowWriter([
    "ensure-session",
    "--artifact-root", artifactRoot,
    "--flow-id", flow,
    "--work-item", workItem,
    ...(taskSlug ? ["--task-slug", taskSlug] : []),
    "--source-request", sourceRequest,
    "--summary", summary,
    ...forwarded,
  ]);
}

async function status(sessionDir: string, json: boolean): Promise<number> {
  const sidecar = readJsonFile(path.join(sessionDir, "state.json"), "workflow state");
  const slug = String(sidecar.task_slug ?? path.basename(sessionDir));
  const projectRoot = path.dirname(path.dirname(path.dirname(sessionDir)));
  const result = await loadBuilderBuildRun({ cwd: projectRoot, runId: slug });
  const report = {
    run_id: result.runId,
    definition_id: result.definitionId,
    definition_version: result.definitionVersion,
    status: result.state.status,
    current_step: result.state.current_step,
    session_dir: sessionDir,
    next_action: sidecar.next_action ?? null,
  };
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.definition_id}@${report.definition_version} ${report.run_id}`);
    console.log(`Status: ${report.status}`);
    console.log(`Step: ${report.current_step}`);
    console.log(`Next: ${String(report.next_action && typeof report.next_action === "object" ? (report.next_action as JsonRecord).summary ?? "" : "")}`);
  }
  return 0;
}

async function evidence(sessionDir: string, argv: string[], json: boolean): Promise<number> {
  const parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, new Set(["artifact-root", "session-dir", "json", "expectation", "status", "summary", "evidence-ref-json", "accepted-gap-reason", "waived-by"]), "workflow evidence");
  if (!flagString(parsed.flags, "expectation")) throw new Error("workflow evidence requires --expectation <gate-expectation-id>");
  if (!flagString(parsed.flags, "status")) throw new Error("workflow evidence requires --status <pass|fail|not_verified>");
  if (!flagString(parsed.flags, "summary")) throw new Error("workflow evidence requires --summary <text>");
  const forwarded = stripPublicFlags(argv, new Set(["artifact-root", "session-dir", "json"]));
  await workflowWriter(["record-gate-claim", sessionDir, ...forwarded]);
  const sidecar = readJsonFile(path.join(sessionDir, "state.json"), "workflow state");
  const projectRoot = path.dirname(path.dirname(path.dirname(sessionDir)));
  const result = await loadBuilderBuildRun({ cwd: projectRoot, runId: String(sidecar.task_slug ?? path.basename(sessionDir)) });
  const report = {
    run_id: result.runId,
    status: result.state.status,
    current_step: result.state.current_step,
    attached: result.attachedEvidence.length > 0,
    next_action: sidecar.next_action ?? null,
  };
  if (json) console.log(JSON.stringify(report));
  else console.log(`Recorded evidence; canonical run is ${report.status} at ${report.current_step}.`);
  return 0;
}

function resolveSessionDir(flags: ReturnType<typeof parseArgs>["flags"]): string {
  const explicit = flagString(flags, "session-dir");
  if (explicit) return validateCanonicalSessionDir(path.resolve(explicit));
  const artifactRoot = path.resolve(flagString(flags, "artifact-root", defaultArtifactRootForRead())!);
  const candidate = currentWorkflowSessionDir(artifactRoot);
  if (!candidate || !isWithin(candidate, artifactRoot) || !fs.existsSync(path.join(candidate, "state.json"))) {
    throw new Error("current workflow pointer does not resolve to a valid session; pass --session-dir explicitly");
  }
  return validateCanonicalSessionDir(candidate);
}

function doctor(argv: string[]): number {
  const parsed = parseArgs(argv);
  const projectRoot = path.resolve(flagString(parsed.flags, "project-root", process.cwd())!);
  const artifactRoot = path.resolve(flagString(parsed.flags, "artifact-root", defaultArtifactRootForRead(projectRoot))!);
  const packageRoot = PACKAGE_ROOT;
  const packageJson = PACKAGE_METADATA;
  const cliVersion = CLI_VERSION;
  const installFile = path.join(projectRoot, ".flow-agents", "install.json");
  const install = readOptionalJson(installFile);
  const state = readCurrentState(artifactRoot);
  const packageKit = readOptionalJson(path.join(packageRoot, "kits", "builder", "kit.json"));
  const packageFlow = readOptionalJson(path.join(packageRoot, "kits", "builder", "flows", "build.flow.json"));
  const installedKitFile = path.join(projectRoot, "kits", "builder", "kit.json");
  const installedFlowFile = path.join(projectRoot, "kits", "builder", "flows", "build.flow.json");
  const installedKit = readOptionalJson(installedKitFile);
  const installedFlow = readOptionalJson(installedFlowFile);
  const resolvedFlowPackage = readOptionalJson(resolveDependencyPackageJson("@kontourai/flow"));
  const installedVersion = typeof install?.version === "string" ? install.version : null;
  const staleInstall = installedVersion !== null && installedVersion !== cliVersion;
  const activeKitIds = Array.isArray(install?.active_kit_ids) ? install.active_kit_ids.map(String) : (installedKit ? ["builder"] : []);
  const runtime = typeof install?.runtime === "string" ? install.runtime : "base";
  const remediation = pinnedFlowAgentsCommand(cliVersion, ["init", "--runtime", runtime, "--dest", projectRoot, ...activeKitIds.flatMap((id) => ["--activate-kit", id]), "--yes"]);
  const localDependencyFile = path.join(projectRoot, "node_modules", "@kontourai", "flow-agents", "package.json");
  const localDependency = readOptionalJson(localDependencyFile);
  const installIntegrity = verifyInstalledAssets(projectRoot, packageRoot, runtime);
  const warnings: string[] = [];
  if (!install) warnings.push(`No installed hook/bundle version found at ${installFile}. Run: ${remediation}`);
  else if (staleInstall) warnings.push(`Installed hook/writer version ${installedVersion} is incompatible with CLI ${cliVersion}. Run: ${remediation}`);
  if (!installIntegrity.ok) warnings.push(`Installed hook/writer assets failed integrity verification: ${installIntegrity.problems.join("; ")}. Run: ${remediation}`);
  if (localDependency?.version && localDependency.version !== cliVersion) warnings.push(`Repository-local Flow Agents ${String(localDependency.version)} differs from executing CLI ${cliVersion}; keep automation explicitly versioned.`);
  if (activeKitIds.includes("builder") && !installedKit) warnings.push(`Activated Builder Kit is missing at ${installedKitFile}. Run: ${remediation}`);
  if (activeKitIds.includes("builder") && !installedFlow) warnings.push(`Activated builder.build definition is missing at ${installedFlowFile}. Run: ${remediation}`);
  if (installedKit && installedKit.schema_version !== packageKit?.schema_version) {
    warnings.push(`Installed Builder Kit schema ${String(installedKit.schema_version)} differs from CLI schema ${String(packageKit?.schema_version)}. Run: ${remediation}`);
  }
  if (installedKit && fileSha256(installedKitFile) !== fileSha256(path.join(packageRoot, "kits", "builder", "kit.json"))) {
    warnings.push(`Installed Builder Kit content differs from Flow Agents ${cliVersion}. Run: ${remediation}`);
  }
  if (installedFlow && installedFlow.version !== packageFlow?.version) {
    warnings.push(`Installed builder.build version ${String(installedFlow.version)} differs from CLI version ${String(packageFlow?.version)}. Run: ${remediation}`);
  }
  if (state?.flow_run && (state.flow_run as JsonRecord).definition_version !== packageFlow?.version) {
    warnings.push(`Current run uses builder.build@${String((state.flow_run as JsonRecord).definition_version)} while CLI resolves ${String(packageFlow?.version)}; recover or migrate before mutation.`);
  }
  if (state && state.schema_version !== "1.0") warnings.push(`Artifact schema ${String(state.schema_version)} is unsupported; recreate or migrate the session with CLI ${cliVersion}.`);
  const trustBundleSchema = readCurrentTrustBundleSchema(artifactRoot);
  if (trustBundleSchema !== null && trustBundleSchema !== "1.0") warnings.push(`Trust bundle schema ${String(trustBundleSchema)} is unsupported; recreate or migrate the session with CLI ${cliVersion}.`);
  const resolvedFlowVersion = typeof resolvedFlowPackage?.version === "string" ? resolvedFlowPackage.version : null;
  const expectedFlowRange = packageJson.dependencies && typeof packageJson.dependencies === "object" ? String((packageJson.dependencies as JsonRecord)["@kontourai/flow"] ?? "") : "";
  if (!resolvedFlowVersion || !flowVersionCompatible(resolvedFlowVersion, expectedFlowRange)) {
    warnings.push(`Resolved Flow runtime ${resolvedFlowVersion ?? "missing"} does not satisfy ${expectedFlowRange || "the package contract"}. Reinstall Flow Agents ${cliVersion}.`);
  }
  const report = {
    ok: warnings.length === 0,
    project_root: projectRoot,
    cli: { version: cliVersion, workflow_contract_version: WORKFLOW_CONTRACT_VERSION, package_root: packageRoot },
    writer: { contract_version: WORKFLOW_WRITER_CONTRACT_VERSION, package_version: cliVersion },
    hook: { contract_version: install && !staleInstall && installIntegrity.ok ? WORKFLOW_CONTRACT_VERSION : null, install_version: installedVersion, path: installIntegrity.hook_config, integrity: installIntegrity },
    local_dependency: {
      version: localDependency?.version ?? null,
      path: localDependency ? path.dirname(localDependencyFile) : null,
      selected: localDependency ? fs.realpathSync(path.dirname(localDependencyFile)) === fs.realpathSync(packageRoot) : false,
    },
    installed: {
      hooks: { version: installedVersion, source: installIntegrity.hook_config, compatible: Boolean(install && !staleInstall && installIntegrity.ok) },
      writer: { version: cliVersion, source: packageRoot, compatible: true },
      runtime: install?.runtime ?? null,
      active_kit_ids: activeKitIds,
    },
    kit: {
      id: packageKit?.id ?? null,
      resolved_schema_version: packageKit?.schema_version ?? null,
      installed_schema_version: installedKit?.schema_version ?? null,
      resolved_content_sha256: fileSha256(path.join(packageRoot, "kits", "builder", "kit.json")),
      installed_content_sha256: installedKit ? fileSha256(installedKitFile) : null,
      source: installedKit ? installedKitFile : path.join(packageRoot, "kits", "builder", "kit.json"),
    },
    flow_runtime: { package_version: resolvedFlowVersion, expected_range: expectedFlowRange, compatible: resolvedFlowVersion ? flowVersionCompatible(resolvedFlowVersion, expectedFlowRange) : false },
    definition: { id: (state?.flow_run as JsonRecord | undefined)?.definition_id ?? packageFlow?.id ?? null, version: (state?.flow_run as JsonRecord | undefined)?.definition_version ?? packageFlow?.version ?? null },
    artifact: {
      state_schema_version: state?.schema_version ?? null,
      trust_bundle_schema_version: trustBundleSchema,
      session: state ? resolveStateSession(artifactRoot) : null,
    },
    warnings,
    remediation: warnings.length ? remediation : null,
  };
  if (flagBool(parsed.flags, "json")) console.log(JSON.stringify(report));
  else {
    console.log(`Flow Agents CLI: ${cliVersion}`);
    console.log(`Installed hooks/writer: ${installedVersion ?? "missing"}`);
    console.log(`Builder Kit schema: installed=${String(installedKit?.schema_version ?? "missing")} resolved=${String(packageKit?.schema_version ?? "missing")}`);
    console.log(`Flow: ${String(report.definition.id ?? "none")}@${String(report.definition.version ?? "unknown")}`);
    console.log(`Artifact schema: state=${String(report.artifact.state_schema_version ?? "none")} trust=${String(report.artifact.trust_bundle_schema_version ?? "none")}`);
    for (const warning of warnings) console.log(`WARNING: ${warning}`);
  }
  return report.ok ? 0 : 2;
}

function readCurrentState(artifactRoot: string): JsonRecord | null {
  try {
    const session = resolveSessionDir({ "artifact-root": artifactRoot });
    return readJsonFile(path.join(session, "state.json"), "workflow state");
  } catch {
    return null;
  }
}

function resolveStateSession(artifactRoot: string): string | null {
  try { return resolveSessionDir({ "artifact-root": artifactRoot }); } catch { return null; }
}

function readJsonFile(file: string, label: string): JsonRecord {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`${label} must be a regular file no larger than 1 MiB`);
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
    return value as JsonRecord;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readOptionalJson(file: string): JsonRecord | null {
  try { return readJsonFile(file, file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function stripPublicFlags(argv: string[], removed: Set<string>): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { result.push(token); continue; }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    if (!removed.has(key)) { result.push(token); continue; }
    if (equals === -1 && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) index += 1;
  }
  return result;
}

function keepFlags(argv: string[], kept: Set<string>): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    const hasValue = equals === -1 && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--");
    if (kept.has(key)) {
      result.push(token);
      if (hasValue) result.push(argv[index + 1]);
    }
    if (hasValue) index += 1;
  }
  return result;
}

function assertOnlyFlags(flags: ReturnType<typeof parseArgs>["flags"], allowed: Set<string>, command: string): void {
  const unsupported = Object.keys(flags).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`${command} does not support --${unsupported}`);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fileSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readCurrentTrustBundleSchema(artifactRoot: string): unknown {
  const session = resolveStateSession(artifactRoot);
  if (!session) return null;
  return readOptionalJson(path.join(session, "trust.bundle"))?.schema_version ?? null;
}

function validateCanonicalSessionDir(candidate: string): string {
  const sessionDir = path.resolve(candidate);
  const artifactRoot = path.dirname(sessionDir);
  const kontouraiRoot = path.dirname(artifactRoot);
  const projectRoot = path.dirname(kontouraiRoot);
  if (path.basename(artifactRoot) !== "flow-agents" || path.basename(kontouraiRoot) !== ".kontourai" || path.dirname(sessionDir) !== artifactRoot) {
    throw new Error("workflow session must be .kontourai/flow-agents/<slug>");
  }
  for (const [label, entry, kind] of [
    ["project root", projectRoot, "directory"],
    [".kontourai root", kontouraiRoot, "directory"],
    ["artifact root", artifactRoot, "directory"],
    ["session directory", sessionDir, "directory"],
    ["workflow state", path.join(sessionDir, "state.json"), "file"],
  ] as const) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) throw new Error(`${label} must be a non-symlink ${kind}`);
  }
  const bundle = path.join(sessionDir, "trust.bundle");
  if (fs.existsSync(bundle)) {
    const stat = fs.lstatSync(bundle);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("workflow trust bundle must be a non-symlink file");
  }
  return sessionDir;
}

function verifyInstalledAssets(projectRoot: string, packageRoot: string, runtime: string): { ok: boolean; problems: string[]; hook_config: string | null } {
  const problems: string[] = [];
  const bundleRoot = path.join(packageRoot, "dist", runtime);
  for (const relativeRoot of ["build/src", "scripts/hooks"]) {
    const expectedRoot = path.join(bundleRoot, relativeRoot);
    if (!fs.existsSync(expectedRoot)) {
      problems.push(`package bundle is missing: ${relativeRoot}`);
      continue;
    }
    const pending = [expectedRoot];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const expected = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(expected);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = path.relative(bundleRoot, expected);
        const installed = path.join(projectRoot, relative);
        try {
          const stat = fs.lstatSync(installed);
          const matches = runtime === "kiro"
            ? fs.readFileSync(installed, "utf8") === fs.readFileSync(expected, "utf8").replaceAll("__KIRO_PACKAGE_ROOT__", projectRoot)
            : fileSha256(installed) === fileSha256(expected);
          if (stat.isSymbolicLink() || !stat.isFile() || !matches) problems.push(`asset mismatch: ${relative}`);
        } catch { problems.push(`asset missing: ${relative}`); }
      }
    }
  }
  const verifyExactRuntimeFile = (relative: string, expectedContent?: string): void => {
    const expected = path.join(bundleRoot, relative);
    const installed = path.join(projectRoot, relative);
    try {
      const stat = fs.lstatSync(installed);
      const matches = expectedContent === undefined ? fileSha256(installed) === fileSha256(expected) : fs.readFileSync(installed, "utf8") === expectedContent;
      if (stat.isSymbolicLink() || !stat.isFile() || !matches) problems.push(`runtime wiring mismatch: ${relative}`);
    } catch { problems.push(`runtime wiring missing: ${relative}`); }
  };
  const verifyManagedHooks = (relative: string): void => {
    const installedFile = path.join(projectRoot, relative);
    try {
      const stat = fs.lstatSync(installedFile);
      const installed = readJsonFile(installedFile, "installed runtime hook configuration");
      const expected = readJsonFile(path.join(bundleRoot, relative), "packaged runtime hook configuration");
      const installedHooks = installed.hooks as JsonRecord | undefined;
      const expectedHooks = expected.hooks as JsonRecord | undefined;
      const complete = !stat.isSymbolicLink() && stat.isFile() && installedHooks && expectedHooks && Object.entries(expectedHooks).every(([event, groups]) => {
        const actualGroups = installedHooks[event];
        return Array.isArray(groups) && Array.isArray(actualGroups) && groups.every((group) => actualGroups.some((actual) => isDeepStrictEqual(actual, group)));
      });
      if (!complete) problems.push("runtime hook configuration does not contain the packaged managed hooks");
    } catch { problems.push("runtime hook configuration is missing"); }
  };

  let hookConfig: string | null = null;
  if (runtime === "codex") {
    hookConfig = path.join(projectRoot, ".codex", "hooks.json");
    verifyManagedHooks(".codex/hooks.json");
  } else if (runtime === "claude-code") {
    hookConfig = path.join(projectRoot, ".claude", "settings.json");
    verifyManagedHooks(".claude/settings.json");
  } else if (runtime === "opencode") {
    hookConfig = path.join(projectRoot, ".opencode", "plugins", "flow-agents.js");
    verifyExactRuntimeFile(".opencode/plugins/flow-agents.js");
  } else if (runtime === "pi") {
    hookConfig = path.join(projectRoot, ".pi", "extensions", "flow-agents.ts");
    verifyExactRuntimeFile(".pi/extensions/flow-agents.ts");
  } else if (runtime === "kiro") {
    hookConfig = path.join(projectRoot, "agents", "dev.json");
    const expectedAgentsRoot = path.join(bundleRoot, "agents");
    try {
      for (const entry of fs.readdirSync(expectedAgentsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
        const relative = path.join("agents", entry.name);
        const rendered = fs.readFileSync(path.join(expectedAgentsRoot, entry.name), "utf8").replaceAll("__KIRO_PACKAGE_ROOT__", projectRoot);
        verifyExactRuntimeFile(relative, rendered);
      }
    } catch { problems.push("runtime wiring missing: agents"); }
  }
  return { ok: problems.length === 0, problems, hook_config: hookConfig };
}

function flowVersionCompatible(version: string, range: string): boolean {
  const actual = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  const minimum = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!actual || !minimum) return false;
  const a = actual.slice(1).map(Number);
  const m = minimum.slice(1).map(Number);
  if (a[0] !== m[0]) return false;
  return a[1] > m[1] || (a[1] === m[1] && a[2] >= m[2]);
}

function resolveDependencyPackageJson(packageName: string): string {
  let candidate = path.dirname(REQUIRE.resolve(packageName));
  for (let depth = 0; depth < 8; depth += 1) {
    const metadata = path.join(candidate, "package.json");
    if (fs.existsSync(metadata)) return metadata;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`could not resolve ${packageName} package metadata`);
}
