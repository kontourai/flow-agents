#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

type AnyObj = Record<string, any>;

const statuses = new Set(["new", "planning", "planned", "in_progress", "blocked", "verifying", "verified", "needs_decision", "not_verified", "failed", "delivered", "accepted", "archived"]);
const phases = ["idea", "backlog", "pickup", "planning", "execution", "verification", "goal_fit", "evidence", "release", "learning", "done"];
const checkKinds = new Set(["build", "types", "lint", "test", "security", "diff", "browser", "runtime", "policy", "external"]);
const checkStatuses = new Set(["pass", "fail", "not_verified", "skip"]);
const verdicts = new Set(["pass", "partial", "fail", "not_verified"]);

function now(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function read(file: string): string { return fs.readFileSync(file, "utf8"); }
function writeJson(file: string, payload: AnyObj): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); }
function printJson(payload: AnyObj): void { console.log(JSON.stringify(payload).replace(/":/g, '": ').replace(/,"/g, ', "')); }
function loadJson(file: string, fallback: AnyObj = {}): AnyObj { return fs.existsSync(file) ? JSON.parse(read(file)) : { ...fallback }; }
function appendJsonl(file: string, payload: AnyObj): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(payload, Object.keys(payload).sort()).replace(/":/g, '": ').replace(/,"/g, ', "');
  fs.appendFileSync(file, `${line}\n`);
}
function die(message: string): never { throw new Error(message); }
function slugify(value: string, fallback: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback; }

function safeRepoIdentifier(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "");
  if (!trimmed || trimmed.length > 120) return "";
  if (path.isAbsolute(trimmed) || trimmed.includes("\\") || /[\x00-\x1F\x7F]/.test(trimmed)) return "";
  const parts = trimmed.split("/");
  if (parts.length > 2 || parts.some((part) => !part || part === "." || part === "..")) return "";
  if (!parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return "";
  return parts.join("/");
}

function parseRepoRemote(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "");
  const ssh = /^git@[^:]+:(?<owner>[^/]+)\/(?<repo>[^/]+)$/.exec(trimmed);
  if (ssh?.groups) return safeRepoIdentifier(`${ssh.groups.owner}/${ssh.groups.repo}`);
  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return safeRepoIdentifier(`${parts.at(-2)}/${parts.at(-1)}`);
  } catch {
    // Non-URL remotes fall back to repository directory name below.
  }
  return "";
}

function repoIdentifier(): string {
  const explicit = safeRepoIdentifier(process.env.FLOW_AGENTS_REPO ?? "");
  if (explicit) return explicit;
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = parseRepoRemote(remote);
    if (parsed) return parsed;
  } catch {
    // Keep sidecar writing independent of Git availability.
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return safeRepoIdentifier(path.basename(top)) || "workspace";
  } catch {
    // Fall through to cwd basename for non-Git workspaces.
  }
  return safeRepoIdentifier(path.basename(process.cwd())) || "workspace";
}

function sidecarBase(slug: string): AnyObj {
  return { schema_version: "1.0", task_slug: slug, repo: repoIdentifier() };
}

function parseArgs(argv: string[]): { command: string; positional: string[]; opts: Record<string, string[]>; flags: Set<string> } {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) flags.add(key);
    else { (opts[key] ??= []).push(next); i += 1; }
  }
  return { command: command ?? "", positional, opts, flags };
}
function opt(parsed: ReturnType<typeof parseArgs>, key: string, fallback = ""): string { return parsed.opts[key]?.at(-1) ?? fallback; }
function opts(parsed: ReturnType<typeof parseArgs>, key: string): string[] { return parsed.opts[key] ?? []; }

function isUnderDir(dir: string, root: string): boolean {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedDir = fs.realpathSync(dir);
  const relative = path.relative(resolvedRoot, resolvedDir);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function explicitArtifactRoot(p: ReturnType<typeof parseArgs>): string {
  const explicit = opt(p, "artifact-dir");
  const configuredRoot = opt(p, "artifact-root");
  if (!explicit) return path.resolve(configuredRoot || ".flow-agents");
  const dir = path.resolve(explicit);
  if (!fs.existsSync(dir)) die(`artifact directory does not exist: ${dir}`);
  if (fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (configuredRoot) {
    const root = path.resolve(configuredRoot);
    if (!isUnderDir(dir, root)) die(`artifact directory must be under artifact root: ${dir} is outside ${root}`);
    return root;
  }
  return path.dirname(dir);
}

function requireArtifactDirUnderRoot(dir: string, root: string): void {
  if (!dir || !fs.existsSync(dir)) die("artifact directory does not exist");
  if (fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (!isUnderDir(dir, root)) die(`artifact directory must be under artifact root: ${dir} is outside ${root}`);
}

function isPermissionDeniedLockError(error: NodeJS.ErrnoException): boolean {
  return error.code === "EPERM" || error.code === "EACCES";
}

function lockAcquisitionFailureMessage(command: string, lockDir: string, error: NodeJS.ErrnoException): string {
  const original = error.message || error.code || String(error);
  if (!isPermissionDeniedLockError(error)) {
    return `failed to acquire workflow sidecar lock for ${command}: ${lockDir}: ${original}`;
  }
  return [
    `failed to acquire workflow sidecar lock for ${command}: ${lockDir}: ${original}`,
    "Likely cause: local directory permissions, ownership, or sandbox restrictions prevented creating the lock directory.",
    "Safe next step: fix permissions or ownership on the artifact directory, or rerun in an approved writable workspace.",
    "If still blocked: manually write schema-valid sidecars and run workflow artifact validation rather than bypassing locks.",
  ].join(" ");
}

async function withLock<T>(dir: string, create: boolean, command: string, body: () => T): Promise<T> {
  if (create) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir)) return body();
  const lockDir = path.join(dir, ".workflow-sidecar.lockdir");
  const staleMs = Number(process.env.FLOW_AGENTS_WORKFLOW_SIDECAR_STALE_LOCK_MS ?? 5 * 60 * 1000);
  const deadline = Date.now() + 30000;
  while (true) {
    try { fs.mkdirSync(lockDir); break; }
    catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (lockError.code !== "EEXIST") {
        die(lockAcquisitionFailureMessage(command, lockDir, lockError));
      }
      try {
        const stat = fs.statSync(lockDir);
        if (staleMs > 0 && Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() > deadline) die(`timed out waiting for workflow sidecar lock for ${command}: ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const delay = process.env.FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY;
    if (delay) await new Promise((resolve) => setTimeout(resolve, Number(delay) * 1000));
    return body();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function section(text: string, heading: string): string {
  const match = new RegExp(`^(?<marks>##+)\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
  if (!match?.groups) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = new RegExp(`^#{2,${match.groups.marks.length}}\\s+`, "m").exec(rest);
  return rest.slice(0, next?.index).trim();
}
function definitionAcceptanceLines(markdown: string): string[] {
  const out: string[] = [];
  let active = false;
  for (const raw of section(markdown, "Definition Of Done").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-\s+\*\*Acceptance criteria:\*\*/i.test(line)) { active = true; continue; }
    if (active && /^-\s+\*\*(Usefulness checks|Stop-short risks|Durable docs target|Scope|User outcome):\*\*/i.test(line)) break;
    if (active && /^-\s+\[[ xX]\]/.test(line)) out.push(line);
  }
  return out;
}
function parseCriterion(line: string, index: number): AnyObj {
  let text = line.replace(/^-\s+\[[ xX]\]\s*/, "").trim();
  const m = /\s+-\s+Evidence:\s*(.+)$/i.exec(text);
  const evidence = m?.[1]?.trim().replace(/\.$/, "");
  if (m) text = text.slice(0, m.index).trim().replace(/\.$/, "");
  const item: AnyObj = { id: slugify(text, `criterion-${index + 1}`), description: text, status: "pending" };
  if (evidence) item.evidence_refs = [evidenceRef("command", { excerpt: evidence })];
  return item;
}
function artifactDirFrom(value: string): string { return path.extname(value) ? path.dirname(value) : value; }
function taskSlugFor(dir: string, explicit = ""): string { return explicit || path.basename(dir); }
function relArtifacts(dir: string): string[] { return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".md") || n.endsWith(".json")).sort() : []; }
function sessionDirFor(root: string, slug: string): string {
  if (!slug) die("--task-slug is required");
  if (path.isAbsolute(slug)) die("--task-slug must be a relative slug");
  if (slug.includes("..")) die("--task-slug must not contain '..'");
  if (slug.includes("/") || slug.includes("\\") || path.basename(slug) !== slug) die("--task-slug must not contain path separators");
  const dir = path.resolve(root, slug);
  const relative = path.relative(root, dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) die("session directory must stay under artifact root");
  return dir;
}

function validateAgentId(agent: string): string {
  if (!agent) die("--agent-id is required");
  if (path.isAbsolute(agent)) die("--agent-id must be a relative slug");
  if (agent.includes("..")) die("--agent-id must not contain '..'");
  if (agent.includes("/") || agent.includes("\\") || path.basename(agent) !== agent) die("--agent-id must not contain path separators");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agent)) die("--agent-id must be a conservative slug");
  return agent;
}

function writeCurrent(root: string, dir: string, timestamp: string, owner: string, source: string): void {
  writeJson(path.join(root, "current.json"), {
    schema_version: "1.0",
    active_slug: path.basename(dir),
    artifact_dir: path.relative(root, dir) || ".",
    updated_at: timestamp,
    owner,
    source,
    active_agents: [],
  });
}
function loadCurrent(root: string): AnyObj | null {
  const file = path.join(root, "current.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(read(file));
}
function currentDir(root: string): string | null {
  const c = loadCurrent(root);
  if (!c) return null;
  const dir = path.resolve(root, c.artifact_dir ?? c.active_slug ?? "");
  return fs.existsSync(dir) ? dir : null;
}
function updateCurrentAgent(root: string, dir: string, agentId: string, status: string, timestamp: string): void {
  const cur = loadCurrent(root);
  if (!cur || path.resolve(root, cur.artifact_dir ?? "") !== path.resolve(dir)) return;
  const active = Array.isArray(cur.active_agents) ? cur.active_agents.filter((a: AnyObj) => a.agent_id !== agentId) : [];
  if (status === "active" || status === "blocked") active.push({ agent_id: agentId, status, updated_at: timestamp });
  cur.active_agents = active;
  cur.updated_at = timestamp;
  writeJson(path.join(root, "current.json"), cur);
}

function initSidecars(dir: string, slug: string, sourceRequest: string, summary: string, nextAction: string, timestamp: string, markdown?: string): void {
  const criteria = markdown ? definitionAcceptanceLines(markdown).map(parseCriterion) : [];
  writeJson(path.join(dir, "state.json"), {
    ...sidecarBase(slug), status: "planned", phase: "planning", created_at: timestamp, updated_at: timestamp,
    artifact_paths: relArtifacts(dir),
    next_action: { status: "continue", summary: nextAction || summary },
  });
  writeJson(path.join(dir, "acceptance.json"), {
    ...sidecarBase(slug), source_request: sourceRequest,
    criteria,
    goal_fit: { status: "pending", summary: "Goal fit has not been verified yet." },
  });
  writeJson(path.join(dir, "handoff.json"), {
    ...sidecarBase(slug), summary, current_state_ref: "state.json", next_steps: nextAction ? [nextAction] : [], blockers: [], warnings: [],
  });
}

function ensureSession(p: ReturnType<typeof parseArgs>): number {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const slug = opt(p, "task-slug") || die("--task-slug is required");
  const dir = sessionDirFor(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = opt(p, "timestamp", now());
  let md = fs.existsSync(path.join(dir, `${slug}--deliver.md`)) ? read(path.join(dir, `${slug}--deliver.md`)) : "";
  if (!md) {
    md = `# ${opt(p, "title", slug)}\n\nbranch: main\nworktree: main\ncreated: ${timestamp}\nstatus: planning\ntype: deliver\niteration: 1\n\n## Plan\n\n${opt(p, "summary", "")}\n\n## Definition Of Done\n\n- **User outcome:** ${opt(p, "summary", "Workflow session is durable.")}\n- **Scope:** Workflow session artifacts and sidecars.\n- **Acceptance criteria:**\n${opts(p, "criterion").map((c) => `  - [ ] ${c} - Evidence: pending.`).join("\n")}\n- **Usefulness checks:**\n  - [ ] User-facing workflow is documented or discoverable\n- **Stop-short risks:** Workflow artifacts could drift.\n- **Durable docs target:** not needed\n- **Sandbox mode:** local-edit\n\n## Execution Progress\n\n- [ ] Session initialized.\n\n## Verification Report\n\nBuild: [NOT_VERIFIED] Verification has not run yet.\n\n### Acceptance Criteria\n- [NOT_VERIFIED] Verification has not run yet - Evidence: pending workflow execution and checks.\n\n### Verdict: NOT_VERIFIED\n\n## Goal Fit Gate\n\n- [ ] Original user goal restated\n\n## Final Acceptance\n\n- [ ] CI/relevant checks passed or local equivalent recorded\n`;
    fs.writeFileSync(path.join(dir, `${slug}--deliver.md`), md);
  }
  if (!fs.existsSync(path.join(dir, "state.json")) || !fs.existsSync(path.join(dir, "acceptance.json")) || !fs.existsSync(path.join(dir, "handoff.json"))) {
    initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action", "Continue."), timestamp, md);
  }
  writeCurrent(root, dir, timestamp, "workflow-sidecar", "ensure-session");
  console.log(dir);
  return 0;
}

function current(p: ReturnType<typeof parseArgs>): number {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = currentDir(root);
  if (!dir) die("no current workflow session is recorded");
  const format = opt(p, "format", "path");
  console.log(format === "slug" ? path.basename(dir) : dir);
  return 0;
}

function recordAgentEvent(p: ReturnType<typeof parseArgs>): number {
  const hasExplicitRoot = !!opt(p, "artifact-root");
  const root = explicitArtifactRoot(p);
  const explicit = opt(p, "artifact-dir");
  const dir = explicit ? path.resolve(explicit) : currentDir(root);
  if (!dir || !fs.existsSync(dir)) die("artifact directory does not exist");
  if (explicit && fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (hasExplicitRoot) requireArtifactDirUnderRoot(dir, root);
  const timestamp = opt(p, "timestamp", now());
  const agent = validateAgentId(opt(p, "agent-id"));
  const event = { timestamp, agent_id: agent, kind: opt(p, "kind", "note"), status: opt(p, "status", "info"), summary: opt(p, "summary"), ...(opt(p, "ref") ? { ref: opt(p, "ref") } : {}) };
  appendJsonl(path.join(dir, "agents", agent, "events.jsonl"), event);
  updateCurrentAgent(root, dir, agent, event.status, timestamp);
  return 0;
}

function initPlan(p: ReturnType<typeof parseArgs>): number {
  const artifact = p.positional[0] || die("artifact path is required");
  const dir = artifactDirFrom(artifact);
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action"), opt(p, "timestamp", now()), read(artifact));
  return 0;
}

function parseJson(value: string, label: string): AnyObj {
  try { const raw = JSON.parse(value); if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("object expected"); return raw; }
  catch { die(`${label} must be valid JSON object`); }
}
function evidenceRef(kind: string, fields: AnyObj): AnyObj {
  return { kind, ...fields };
}
function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
function hasPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1;
}
function validateEvidenceRef(ref: AnyObj, label: string): AnyObj {
  if (!["source", "command", "artifact", "provider", "external"].includes(ref.kind)) die(`${label} entry kind must be one of: source, command, artifact, provider, external`);
  for (const key of Object.keys(ref)) if (!["kind", "url", "file", "line_start", "line_end", "excerpt", "summary"].includes(key)) die(`${label} entries contain unsupported field: ${key}`);
  if (ref.url !== undefined && !hasNonEmptyString(ref.url)) die(`${label} entry url must be a non-empty string`);
  if (ref.file !== undefined && !hasNonEmptyString(ref.file)) die(`${label} entry file must be a non-empty string`);
  if (ref.excerpt !== undefined && !hasNonEmptyString(ref.excerpt)) die(`${label} entry excerpt must be a non-empty string`);
  if (ref.summary !== undefined && !hasNonEmptyString(ref.summary)) die(`${label} entry summary must be a non-empty string`);
  if (ref.line_start !== undefined && !hasPositiveInteger(ref.line_start)) die(`${label} entry line_start must be a positive integer`);
  if (ref.line_end !== undefined && !hasPositiveInteger(ref.line_end)) die(`${label} entry line_end must be a positive integer`);
  if (ref.kind === "source" && (!hasNonEmptyString(ref.file) || !hasPositiveInteger(ref.line_start) || !hasPositiveInteger(ref.line_end) || !hasNonEmptyString(ref.excerpt))) die(`${label} source refs require file, line_start, line_end, and excerpt`);
  if (ref.kind === "artifact" && (!hasNonEmptyString(ref.file) && !hasNonEmptyString(ref.url))) die(`${label} artifact refs require file or url`);
  if (ref.kind === "artifact" && (!hasNonEmptyString(ref.summary) && !hasNonEmptyString(ref.excerpt))) die(`${label} artifact refs require summary or excerpt`);
  if (ref.kind === "command" && (!hasNonEmptyString(ref.summary) && !hasNonEmptyString(ref.excerpt) && !hasNonEmptyString(ref.url))) die(`${label} command refs require summary, excerpt, or url`);
  if ((ref.kind === "provider" || ref.kind === "external") && !hasNonEmptyString(ref.url)) die(`${label} ${ref.kind} refs require url`);
  return ref;
}
function normalizeEvidenceRefs(raw: unknown, label: string): AnyObj[] {
  if (!Array.isArray(raw)) die(`${label} must be an array`);
  return raw.map((ref) => {
    if (typeof ref === "string") die(`${label} entries must be structured evidence reference objects; legacy string refs are not supported`);
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) die(`${label} entries must be objects`);
    return validateEvidenceRef({ ...ref as AnyObj }, label);
  });
}
function normalizeCheck(raw: AnyObj): AnyObj {
  const check = { ...raw };
  if (!check.id || !check.kind || !check.status || !check.summary) die("check requires id, kind, status, and summary");
  if (!checkKinds.has(check.kind)) die("kind must be one of: build, types, lint, test, security, diff, browser, runtime, policy, external");
  if (!checkStatuses.has(check.status)) die("status must be one of: pass, fail, not_verified, skip");
  if (Array.isArray(check.standard_refs)) for (const ref of check.standard_refs) if (!["junit", "sarif", "coverage", "veritas"].includes(ref.standard)) die("standard must be one of");
  if (check.artifact_refs) check.artifact_refs = normalizeEvidenceRefs(check.artifact_refs, "artifact_refs");
  if (check.surface_trust_refs) check.surface_trust_refs = normalizeSurfaceRefs(check.surface_trust_refs);
  return check;
}
function normalizeSurfaceRefs(refs: any): AnyObj[] {
  if (!Array.isArray(refs)) die("surface_trust_refs must be an array");
  return refs.map((ref) => {
    const keys = JSON.stringify(ref).match(/"([^"]+)":/g) ?? [];
    for (const key of keys.map((k) => k.slice(1, -2))) if (key.toLowerCase().includes("veritas")) die(`unsupported field in Surface trust ref: ${key}`);
    const out = { ...ref };
    if (!["TrustReport", "Trust Snapshot"].includes(out.artifact_kind)) die("artifact_kind must be one of");
    const status = deriveSurfaceStatus(out);
    if (out.status === "pass" && status !== "pass") die("surface_trust_refs contradicts Surface trust facts");
    return out;
  });
}
function deriveSurfaceStatus(ref: AnyObj): string {
  if (ref.claim_status !== "accepted") return "fail";
  if (ref.freshness?.status !== "fresh") return "not_verified";
  if (!ref.authority || ref.authority.producer === "unknown") return "fail";
  if (ref.integrity?.status !== "matched") return "fail";
  return "pass";
}
function surfaceCheckFromArtifact(file: string, index: number): AnyObj {
  const raw = JSON.parse(read(file));
  const lower = JSON.stringify(raw).toLowerCase();
  let ref: AnyObj;
  if (lower.includes("provider") && lower.includes("absent")) {
    ref = { artifact_kind: "TrustReport", artifact_ref: file, gate_id: "provider.unavailable", claim_type: "surface.claim", claim_status: "unknown", subject: "builder-kit", freshness: { status: "unknown", summary: "No trust provider is configured" }, authority: { producer: "unknown", summary: "No trust provider is configured" }, integrity: { status: "unknown", summary: "Unknown" }, status: "not_verified", summary: "No trust provider is configured" };
  } else if (lower.includes("artifact") && lower.includes("absent")) {
    ref = { artifact_kind: "TrustReport", artifact_ref: file, gate_id: "artifact.unavailable", claim_type: "surface.claim", claim_status: "unknown", subject: "builder-kit", freshness: { status: "unknown", summary: "Artifact not readable" }, authority: { producer: "unknown", summary: "Artifact not readable" }, integrity: { status: "unknown", summary: "Artifact not readable" }, status: "not_verified", summary: "artifact not readable" };
  } else {
    const claimStatus = lower.includes("rejected") ? "rejected" : "accepted";
    const freshness = lower.includes("stale") ? "stale" : "fresh";
    const producer = lower.includes("missing-authority") ? "unknown" : "surface-local";
    const integrity = lower.includes("mismatch") ? "mismatch" : "matched";
    ref = { artifact_kind: file.includes("snapshot") ? "Trust Snapshot" : "TrustReport", artifact_ref: file, gate_id: "builder.surface.claim", claim_type: "surface.claim", claim_status: claimStatus, subject: "builder-kit", freshness: { status: freshness, summary: freshness === "fresh" ? "fresh" : "not currently verifiable" }, authority: { producer, summary: producer === "unknown" ? "missing authority" : "Local Surface trust producer." }, integrity: { status: integrity, summary: integrity === "matched" ? "matched" : "integrity mismatch" } };
    ref.status = deriveSurfaceStatus(ref);
    ref.summary = ref.status === "pass" ? "accepted" : ref.status === "not_verified" ? "not currently verifiable" : (claimStatus === "rejected" ? "rejected" : producer === "unknown" ? "missing authority" : "integrity mismatch");
  }
  return { id: `surface-trust-${index + 1}`, kind: "policy", status: ref.status, summary: ref.summary, surface_trust_refs: [ref] };
}
function updateAcceptance(dir: string, verdict: string): void {
  const file = path.join(dir, "acceptance.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  const status = verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "not_verified";
  if (Array.isArray(data.criteria)) data.criteria = data.criteria.map((c: AnyObj) => ({ ...c, status }));
  data.goal_fit = { ...(data.goal_fit ?? {}), status, summary: verdict === "pass" ? "Evidence passed." : "Evidence requires follow-up." };
  writeJson(file, data);
}
function validateAcceptanceEvidenceRefs(dir: string): void {
  const file = path.join(dir, "acceptance.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  if (!Array.isArray(data.criteria)) return;
  data.criteria.forEach((criterion: AnyObj, index: number) => {
    if (criterion.evidence_refs !== undefined) normalizeEvidenceRefs(criterion.evidence_refs, `acceptance.criteria[${index}].evidence_refs`);
  });
}
function writeState(dir: string, slug: string, status: string, phase: string, timestamp: string, summary: string, next = "continue"): void {
  writeJson(path.join(dir, "state.json"), { ...loadJson(path.join(dir, "state.json")), ...sidecarBase(slug), status, phase, updated_at: timestamp, artifact_paths: relArtifacts(dir), next_action: { status: next, summary } });
}
function recordEvidence(p: ReturnType<typeof parseArgs>): number {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const verdict = opt(p, "verdict") || die("--verdict is required");
  if (!verdicts.has(verdict)) die("verdict must be one of: pass, partial, fail, not_verified");
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const checks = [...opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json"))), ...opts(p, "surface-trust-json").map(surfaceCheckFromArtifact)];
  if (!checks.length && opts(p, "surface-trust-json").length === 0) die("record-evidence requires at least one --check-json or --surface-trust-json");
  validateAcceptanceEvidenceRefs(dir);
  const payload = { ...sidecarBase(slug), verdict, checks, not_verified_gaps: opts(p, "gap") };
  writeJson(path.join(dir, "evidence.json"), payload);
  updateAcceptance(dir, verdict);
  const stateStatus = verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : "not_verified";
  writeState(dir, slug, stateStatus, "verification", opt(p, "timestamp", now()), "Evidence recorded.");
  return 0;
}

function diagnostic(dir: string, code: string, summary: string): never {
  const payload = { timestamp: now(), code, summary };
  appendJsonl(path.join(dir, "transition-diagnostics.jsonl"), payload);
  die(`${code}: ${summary}`);
}
function advanceState(p: ReturnType<typeof parseArgs>): number {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const status = opt(p, "status");
  const phase = opt(p, "phase");
  const target = opt(p, "target-phase");
  if (!statuses.has(status)) die(`status must be one of: ${[...statuses].join(", ")}`);
  if (!phases.includes(phase)) die(`phase must be one of: ${phases.join(", ")}`);
  if (target && !phases.includes(target)) die(`target phase must be one of: ${phases.join(", ")}`);
  const prev = loadJson(path.join(dir, "state.json"));
  if ((status === "archived" || status === "accepted") && prev.phase !== "learning") diagnostic(dir, "terminal_jump_rejected", "Terminal workflow states require release and learning gates.");
  const flow = opt(p, "flow-definition");
  if (flow === "builder.build" && prev.phase === "verification" && phase === "execution") {
    const reason = opt(p, "route-back-reason");
    if (!reason) diagnostic(dir, "route_back_reason_required", "Builder Kit route-back requires implementation_defect or equivalent reason.");
    const file = path.join(dir, "transition-attempts.json");
    const attempts = loadJson(file);
    const key = `verification->execution:${reason}`;
    const count = attempts[key]?.count ?? 0;
    if (count >= 3) diagnostic(dir, "route_back_attempts_exceeded", "Builder Kit route-back attempts exceeded.");
    attempts[key] = { count: count + 1, reason, updated_at: opt(p, "timestamp", now()) };
    writeJson(file, attempts);
  }
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  writeState(dir, slug, status, phase, timestamp, opt(p, "summary"));
  writeJson(path.join(dir, "handoff.json"), { ...loadJson(path.join(dir, "handoff.json")), ...sidecarBase(slug), summary: opt(p, "summary"), current_state_ref: "state.json", next_steps: [opt(p, "next-action")].filter(Boolean), blockers: [], warnings: [] });
  return 0;
}

function normalizeFinding(raw: AnyObj): AnyObj {
  if (raw.file_refs !== undefined && !Array.isArray(raw.file_refs)) die("file_refs must be an array");
  return raw;
}
function critiqueStatus(critiques: AnyObj[], required: boolean): string {
  if (!required && critiques.length === 0) return "not_required";
  if (critiques.some((c) => c.verdict === "fail" || (Array.isArray(c.findings) && c.findings.some((f: AnyObj) => f.status === "open")))) return "fail";
  return "pass";
}
function recordCritique(p: ReturnType<typeof parseArgs>): number {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const existing = loadJson(path.join(dir, "critique.json"), { critiques: [] });
  const critique = { id: opt(p, "id") || "review", reviewer: opt(p, "reviewer", "tool-code-reviewer"), reviewed_at: opt(p, "timestamp", now()), verdict: opt(p, "verdict", "pass"), summary: opt(p, "summary"), artifact_refs: opts(p, "artifact-ref"), findings: opts(p, "finding-json").map((v) => normalizeFinding(parseJson(v, "--finding-json"))) };
  const critiques = [...(Array.isArray(existing.critiques) ? existing.critiques : []), critique];
  if (critique.verdict === "pass" && critique.findings.some((f: AnyObj) => f.status === "open")) die("required critique must pass");
  writeJson(path.join(dir, "critique.json"), { ...sidecarBase(slug), status: critiqueStatus(critiques, true), required: true, updated_at: critique.reviewed_at, critiques });
  return 0;
}
function frontmatter(text: string, key: string): string {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text.slice(0, end))?.[1]?.trim() ?? "";
}
function importCritique(p: ReturnType<typeof parseArgs>): number {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const review = p.positional[1] || die("review artifact is required");
  const text = read(review);
  const role = frontmatter(text, "role");
  if (!["review", "code-review"].includes(role)) die("review artifact must declare role");
  const verdictRaw = (frontmatter(text, "verdict") || /###\s+Verdict:\s*([A-Z_]+)/i.exec(text)?.[1] || "PASS").toUpperCase();
  const verdict = verdictRaw === "CHANGES_REQUESTED" || verdictRaw === "FAIL" ? "fail" : verdictRaw === "NOT_VERIFIED" ? "not_verified" : "pass";
  const findings: AnyObj[] = [];
  const re = /^####\s+\[(?<severity>[A-Z]+)\]\s+(?<target>.+?)\s+-\s+(?<title>.+)$/gm;
  for (let m; (m = re.exec(text));) {
    const title = m.groups?.title ?? "finding";
    findings.push({ id: slugify(title, `finding-${findings.length + 1}`), severity: (m.groups?.severity ?? "info").toLowerCase(), status: opt(p, "finding-status", verdict === "pass" ? "fixed" : "open"), description: title, file_refs: [m.groups?.target ?? review] });
  }
  const parsed = { ...p, positional: [dir], opts: { ...p.opts, id: [slugify(path.basename(review).replace(/\.md$/, ""), "review")], reviewer: ["tool-code-reviewer"], verdict: [verdict], summary: [`Imported critique from ${path.basename(review)}`], "finding-json": findings.map((f) => JSON.stringify(f)) }, flags: p.flags };
  const result = recordCritique(parsed);
  if (verdict !== "pass") die("required critique must pass");
  return result;
}
function recordRelease(p: ReturnType<typeof parseArgs>): number {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const decision = opt(p, "decision");
  if (!["merge", "release", "deploy", "hold", "rollback_required"].includes(decision)) die("decision must be one of: merge, release, deploy, hold, rollback_required");
  const gates = opts(p, "gate-json").map((v) => parseJson(v, "--gate-json"));
  if (["merge", "release", "deploy"].includes(decision) && !gates.some((g) => g.name === decision && g.status === "pass")) die(`positive release decision requires ${decision} gate to pass`);
  const payload = { ...sidecarBase(slug), decision: opt(p, "decision"), updated_at: opt(p, "timestamp", now()), scope: opt(p, "scope"), evidence_ref: opt(p, "evidence-ref"), gates: opts(p, "gate-json").map((v) => parseJson(v, "--gate-json")), rollback_plan: parseJson(opt(p, "rollback-json", '{"status":"not_required","summary":"Not required.","owner":"maintainer"}'), "--rollback-json"), observability_plan: parseJson(opt(p, "observability-json", '{"status":"not_required","summary":"Not required."}'), "--observability-json"), post_deploy_checks: opts(p, "post-deploy-json").map((v) => parseJson(v, "--post-deploy-json")), docs: parseJson(opt(p, "docs-json", '{"status":"not_needed","summary":"Not needed."}'), "--docs-json") };
  const stateSummary = opt(p, "summary").trim() || `Release readiness recorded for ${decision}.`;
  writeJson(path.join(dir, "release.json"), payload);
  writeState(dir, slug, "delivered", "release", payload.updated_at, stateSummary);
  return 0;
}
function validateLearningCorrection(record: AnyObj): void {
  const correction = record.correction;
  if (correction === undefined) return;
  if (!correction || typeof correction !== "object" || Array.isArray(correction)) die("correction must be an object");
  if (typeof correction.needed !== "boolean") die("correction.needed must be boolean");
  if (correction.needed === false) {
    if (typeof correction.evidence !== "string" || correction.evidence.length === 0) die("correction.evidence is required when correction.needed is false");
    return;
  }
  for (const key of ["type", "recurrence_key", "intended_behavior", "observed_behavior", "gap"]) {
    if (typeof correction[key] !== "string" || correction[key].length === 0) die(`correction.${key} is required when correction.needed is true`);
  }
  if (!["workflow", "skill", "agent", "tooling", "test", "doc", "process", "product", "provider", "none"].includes(correction.type)) {
    die("correction.type must be one of: workflow, skill, agent, tooling, test, doc, process, product, provider, none");
  }
  const prevention = correction.prevention;
  if (prevention !== undefined) validateLearningPrevention(prevention);
  const hasPrevention = prevention !== undefined;
  const hasNoChange = typeof correction.no_change_rationale === "string" && correction.no_change_rationale.length > 0;
  if (!hasPrevention && !hasNoChange) die("correction requires prevention route or no_change_rationale when correction.needed is true");
}
function validateLearningPrevention(prevention: unknown): void {
  if (!prevention || typeof prevention !== "object" || Array.isArray(prevention)) die("correction.prevention must be an object");
  const value = prevention as AnyObj;
  if (typeof value.target !== "string" || value.target.length === 0) die("correction.prevention.target is required");
  if (!["rule", "skill", "power", "agent", "eval", "doc", "backlog", "knowledge", "none"].includes(value.target)) die("correction.prevention.target must be one of: rule, skill, power, agent, eval, doc, backlog, knowledge, none");
  if (typeof value.action !== "string" || value.action.length === 0) die("correction.prevention.action is required");
  if (typeof value.status !== "string" || value.status.length === 0) die("correction.prevention.status is required");
  if (!["open", "completed", "accepted", "deferred", "rejected"].includes(value.status)) die("correction.prevention.status must be one of: open, completed, accepted, deferred, rejected");
}
function normalizeLearning(raw: AnyObj, timestamp: string): AnyObj {
  if (!Array.isArray(raw.source_refs)) die("source_refs must be an array");
  if (!Array.isArray(raw.facts)) die("facts must be an array");
  if (!Array.isArray(raw.routing)) die("routing must be an array");
  if (!["success", "failure", "mixed", "unknown"].includes(raw.outcome)) die("learning outcome must be one of: success, failure, mixed, unknown");
  validateLearningCorrection(raw);
  return { recorded_at: timestamp, ...raw };
}
function recordLearning(p: ReturnType<typeof parseArgs>): number {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  const records = opts(p, "record-json").map((v) => normalizeLearning(parseJson(v, "--record-json"), timestamp));
  const status = opt(p, "status", "learned");
  if (status === "learned" && records.some((r) => r.routing.some((x: AnyObj) => x.status === "open"))) die("learning status learned cannot have open routing");
  if (status === "learned" && records.some((r) => r.correction === undefined)) die("learning status learned requires every record to include correction.needed");
  writeJson(path.join(dir, "learning.json"), { ...sidecarBase(slug), status, updated_at: timestamp, records });
  writeState(dir, slug, "accepted", "learning", timestamp, opt(p, "summary"));
  return 0;
}
function evidenceClean(dir: string): boolean {
  const e = loadJson(path.join(dir, "evidence.json"), {});
  return e.verdict === "pass" && Array.isArray(e.checks) && e.checks.length > 0 && e.checks.every((c: AnyObj) => {
    if (!(c.status === "pass" || c.status === "skip")) return false;
    return !Array.isArray(c.standard_refs) || c.standard_refs.every((r: AnyObj) => ["junit", "sarif", "coverage", "veritas"].includes(r.standard));
  });
}
function critiqueClean(dir: string): boolean {
  const c = loadJson(path.join(dir, "critique.json"), {});
  return c.status === "pass" && Array.isArray(c.critiques) && c.critiques.every((x: AnyObj) => x.verdict !== "fail" && (!Array.isArray(x.findings) || x.findings.every((f: AnyObj) => f.status !== "open" && (f.file_refs === undefined || Array.isArray(f.file_refs)))));
}
function assertExistingLearningValid(dir: string): void {
  const file = path.join(dir, "learning.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  if (!Array.isArray(data.records)) die("learning records must be an array");
  for (const record of data.records) {
    if (!Array.isArray(record.source_refs)) die("source_refs must be an array");
    if (!Array.isArray(record.facts)) die("facts must be an array");
    if (!Array.isArray(record.routing)) die("routing must be an array");
    validateLearningCorrection(record);
    if (data.status === "learned" && record.correction === undefined) die("learning status learned requires every record to include correction.needed");
  }
}
function dogfoodPass(p: ReturnType<typeof parseArgs>): number {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = path.resolve(opt(p, "artifact-dir") || currentDir(root) || "");
  requireArtifactDirUnderRoot(dir, root);
  assertExistingLearningValid(dir);
  const verdict = opt(p, "verdict");
  if (verdict === "pass") {
    const checks = opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json")));
    if (checks.some((c) => c.status !== "pass" && c.status !== "skip")) die("clean evidence requires all non-skipped checks to pass");
    if (fs.existsSync(path.join(dir, "evidence.json")) && !evidenceClean(dir)) die("cannot mark clean without passing evidence");
    if (!fs.existsSync(path.join(dir, "evidence.json")) && checks.length === 0) die("cannot mark clean without passing evidence");
    if (p.flags.has("require-critique") || opt(p, "release-decision")) {
      const newCritiqueVerdict = opt(p, "critique-verdict", "pass");
      for (const value of opts(p, "finding-json")) normalizeFinding(parseJson(value, "--finding-json"));
      if (newCritiqueVerdict !== "pass") die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
      if (!opt(p, "critique-id") && !critiqueClean(dir)) die("requires passing critique");
      if (fs.existsSync(path.join(dir, "critique.json")) && !critiqueClean(dir)) die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
    }
  }
  const learningRecords = opts(p, "learning-record-json").map((v) => normalizeLearning(parseJson(v, "--learning-record-json"), opt(p, "timestamp", now())));
  if (opt(p, "learning-status") === "learned" && learningRecords.some((r) => r.routing.some((x: AnyObj) => x.status === "open"))) die("learned status cannot have open learning routing");
  if (opt(p, "learning-status") === "learned" && learningRecords.some((r) => r.correction === undefined)) die("learned status requires every learning record to include correction.needed");
  if (opts(p, "check-json").length) recordEvidence({ ...p, positional: [dir], opts: { ...p.opts, verdict: [verdict] }, flags: p.flags });
  if (p.flags.has("require-critique") && opt(p, "critique-id")) recordCritique({ ...p, positional: [dir], opts: { ...p.opts, id: [opt(p, "critique-id")], verdict: [opt(p, "critique-verdict", "pass")], summary: [opt(p, "critique-summary", opt(p, "summary"))] }, flags: p.flags });
  if (learningRecords.length) recordLearning({ ...p, positional: [dir], opts: { ...p.opts, status: [opt(p, "learning-status", "learned")], "record-json": opts(p, "learning-record-json"), summary: [opt(p, "learning-summary", opt(p, "summary"))] }, flags: p.flags });
  if (opt(p, "release-decision")) {
    recordRelease({ ...p, positional: [dir], opts: { ...p.opts, decision: [opt(p, "release-decision")], scope: [opt(p, "release-scope")], summary: [opt(p, "release-summary", opt(p, "summary"))], "gate-json": ['{"name":"merge","status":"pass","summary":"Dogfood release gate passed."}'], "evidence-ref": ["evidence.json"], "docs-json": [`{"status":"updated","summary":"Docs updated.","refs":["${opt(p, "release-doc-ref", "docs/workflow-usage-guide.md")}"]}`] }, flags: p.flags });
    printJson({ release_decision: opt(p, "release-decision") });
    return 0;
  }
  const stateStatus = verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : "not_verified";
  const handoff = loadJson(path.join(dir, "handoff.json"));
  if (verdict === "fail") {
    handoff.blockers = ["Required dogfood critique is not passing"];
    writeJson(path.join(dir, "handoff.json"), handoff);
  }
  writeState(dir, taskSlugFor(dir, opt(p, "task-slug")), stateStatus, "verification", opt(p, "timestamp", now()), opt(p, "summary"), verdict === "pass" ? "continue" : "blocked");
  printJson({ state_status: stateStatus });
  return 0;
}

async function main(): Promise<number> {
  const p = parseArgs(process.argv.slice(2));
  if (!p.command) die("workflow-sidecar command is required");
  const lockRoot = ["ensure-session", "current", "dogfood-pass"].includes(p.command) ? path.resolve(opt(p, "artifact-root", ".flow-agents")) : p.command === "record-agent-event" ? explicitArtifactRoot(p) : p.positional[0] ? artifactDirFrom(p.positional[0]) : "";
  return withLock(lockRoot, ["ensure-session", "record-agent-event", "dogfood-pass"].includes(p.command), p.command, () => {
    switch (p.command) {
      case "ensure-session": return ensureSession(p);
      case "current": return current(p);
      case "record-agent-event": return recordAgentEvent(p);
      case "init-plan": return initPlan(p);
      case "record-evidence": return recordEvidence(p);
      case "advance-state": return advanceState(p);
      case "record-critique": return recordCritique(p);
      case "import-critique": return importCritique(p);
      case "record-release": return recordRelease(p);
      case "record-learning": return recordLearning(p);
      case "dogfood-pass": return dogfoodPass(p);
      default: die(`unknown command: ${p.command}`);
    }
  });
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
