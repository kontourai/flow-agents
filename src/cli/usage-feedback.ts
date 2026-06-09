import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, flagBool, flagList, flagString } from "../lib/args.js";

const VALID_RESULTS = new Set(["success", "partial", "failure", "not_verified"]);

function telemetryDir(flags: Record<string, string | boolean | string[]>): string {
  return path.resolve(flagString(flags, "telemetry-dir", process.env.TELEMETRY_DATA_DIR ?? ".telemetry") ?? ".telemetry");
}

function ensureSafeDir(dir: string): void {
  let current = path.resolve(dir);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    missing.push(current);
    current = path.dirname(current);
  }
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`unsafe telemetry path contains symlink: ${current}`);
  const rel = path.relative(current, dir).split(path.sep).filter(Boolean);
  let cursor = current;
  for (const part of rel) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`unsafe telemetry path contains symlink: ${cursor}`);
  }
  for (const item of missing.reverse()) fs.mkdirSync(item);
}

function appendJsonl(file: string, record: unknown): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`refusing to write symlinked file: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeJsonlUpsert(file: string, rows: Record<string, unknown>[], key: string): void {
  const existing = new Map(readJsonl(file).map((row) => [String(row[key]), row]));
  for (const row of rows) existing.set(String(row[key]), row);
  fs.writeFileSync(file, Array.from(existing.values()).map((row) => JSON.stringify(row)).join("\n") + (existing.size ? "\n" : ""), "utf8");
}

function recordOutcome(argv: string[]): number {
  const { flags } = parseArgs(argv);
  const sessionId = flagString(flags, "session-id");
  const result = flagString(flags, "result");
  if (!sessionId) throw new Error("--session-id is required");
  if (!result || !VALID_RESULTS.has(result)) throw new Error("--result must be success, partial, failure, or not_verified");
  const dir = telemetryDir(flags);
  ensureSafeDir(dir);
  const record = {
    schema_version: "1",
    outcome_id: `${sessionId}:${flagString(flags, "task-slug", "outcome")}`,
    recorded_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    session_id: sessionId,
    runtime_session_id: flagString(flags, "runtime-session-id"),
    runtime: flagString(flags, "runtime", "codex"),
    repo: flagString(flags, "repo"),
    agent: flagString(flags, "agent"),
    profile_id: flagString(flags, "profile-id"),
    prompt_id: flagString(flags, "prompt-id"),
    prompt_variant: flagString(flags, "prompt-variant"),
    skill_ids: flagList(flags, "skill-id"),
    skill_variant: flagString(flags, "skill-variant"),
    task_type: flagString(flags, "task-type"),
    task_slug: flagString(flags, "task-slug"),
    result,
    quality_score: flagString(flags, "quality-score") ? Number(flagString(flags, "quality-score")) : null,
    human_minutes_saved: flagString(flags, "human-minutes-saved") ? Number(flagString(flags, "human-minutes-saved")) : null,
    rework_required: flagBool(flags, "rework-required"),
    notes: flagString(flags, "notes"),
    evidence: flagList(flags, "evidence"),
  };
  appendJsonl(path.join(dir, "outcomes.jsonl"), record);
  return 0;
}

function normalize(input: Record<string, unknown>[], runtime: string, flags: Record<string, string | boolean | string[]>, fallbackSource = "flow-agents"): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const event of input) groups.set(String(event.session_id ?? "unknown"), [...(groups.get(String(event.session_id ?? "unknown")) ?? []), event]);
  return Array.from(groups, ([sessionId, events]) => ({
    schema_version: "1",
    session_id: sessionId,
    source_id: flagString(flags, "source-id") ?? String(events.find((event) => event.repo)?.repo ?? fallbackSource),
    runtime,
    repo: flagString(flags, "repo") ?? String(events.find((event) => event.repo)?.repo ?? ""),
    repo_root: flagString(flags, "repo-root"),
    agent: flagString(flags, "agent") ?? String((events.find((event) => event.agent) as { agent?: { name?: string } } | undefined)?.agent?.name ?? "dev"),
    profile_id: flagString(flags, "profile-id") ?? String(events.find((event) => event.profile_id)?.profile_id ?? ""),
    prompt_id: flagString(flags, "prompt-id") ?? String(events.find((event) => event.prompt_id)?.prompt_id ?? ""),
    prompt_variant: flagString(flags, "prompt-variant") ?? String(events.find((event) => event.prompt_variant)?.prompt_variant ?? ""),
    skill_ids: flagList(flags, "skill-id").length ? flagList(flags, "skill-id") : ((events.find((event) => Array.isArray(event.skill_ids))?.skill_ids as string[] | undefined) ?? []),
    skill_variant: flagString(flags, "skill-variant") ?? String(events.find((event) => event.skill_variant)?.skill_variant ?? ""),
    started_at: events[0]?.timestamp,
    ended_at: events[events.length - 1]?.timestamp,
    turns: events.filter((event) => String(event.event_type ?? "").includes("turn.user")).length,
    tool_invocations: events.filter((event) => String(event.event_type ?? "") === "tool.invoke").length,
    delegations: events.filter((event) => String(event.event_type ?? "").includes("delegate")).length,
    permission_requests: events.filter((event) => String(event.event_type ?? "").includes("permission")).length,
  }));
}

function importTelemetry(argv: string[], defaultRuntime?: string): number {
  const { flags } = parseArgs(argv);
  const runtime = defaultRuntime ?? flagString(flags, "runtime", "codex") ?? "codex";
  const input = flagString(flags, "input-full-jsonl") ?? path.join(flagString(flags, "input-telemetry-dir") ?? "", "full.jsonl");
  if (!input || !fs.existsSync(input)) throw new Error(`input telemetry file does not exist: ${input}`);
  const dir = telemetryDir(flags);
  ensureSafeDir(dir);
  const inputDir = flagString(flags, "input-telemetry-dir");
  const fallbackSource = inputDir ? path.basename(path.resolve(inputDir)) : "flow-agents";
  writeJsonlUpsert(path.join(dir, "normalized-sessions.jsonl"), normalize(readJsonl(input), runtime, flags, fallbackSource), "session_id");
  return 0;
}

function artifactOutcomes(artifactPath: string, flags: Record<string, string | boolean | string[]>): Record<string, unknown>[] {
  const files: string[] = [];
  const stat = fs.statSync(artifactPath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(artifactPath, { recursive: true }) as string[]) if (name.endsWith(".md")) files.push(path.join(artifactPath, name));
  } else files.push(artifactPath);
  return files.flatMap((file) => {
    const text = fs.readFileSync(file, "utf8");
    const status = text.match(/^status:\s*(.+)$/m)?.[1].trim() ?? "";
    const type = text.match(/^type:\s*(.+)$/m)?.[1].trim() ?? "";
    const terminal = ["delivered", "accepted", "done"].includes(status);
    if (!terminal && !flagBool(flags, "include-open")) return [];
    const title = text.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() ?? path.basename(file, ".md");
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return [{ schema_version: "1", outcome_id: `artifact:${file}`, recorded_at: new Date().toISOString(), session_id: slug, runtime: flagString(flags, "runtime", "codex"), repo: flagString(flags, "repo"), profile_id: flagString(flags, "profile-id"), prompt_id: flagString(flags, "prompt-id"), skill_ids: flagList(flags, "skill-id"), task_type: type || "deliver", task_slug: slug, result: terminal ? "success" : status === "failed" ? "failure" : "not_verified", quality_score: null, human_minutes_saved: null, rework_required: false, evidence: [file] }];
  });
}

function syncArtifacts(argv: string[]): number {
  const { flags } = parseArgs(argv);
  const dir = telemetryDir(flags);
  ensureSafeDir(dir);
  const artifacts = flagList(flags, "artifact-dir");
  const records = (artifacts.length ? artifacts : [".flow-agents"]).flatMap((item) => fs.existsSync(item) ? artifactOutcomes(item, flags) : []);
  writeJsonlUpsert(path.join(dir, "outcomes.jsonl"), records, "outcome_id");
  if (!flagBool(flags, "quiet")) console.log(`synced ${records.length} artifact outcome(s) to ${path.join(dir, "outcomes.jsonl")}`);
  return 0;
}

function rows(dir: string): { sessions: Record<string, unknown>[]; outcomes: Record<string, unknown>[] } {
  const full = fs.existsSync(path.join(dir, "full.jsonl")) ? path.join(dir, "full.jsonl") : path.join(dir, "sample-full.jsonl");
  const outcomes = fs.existsSync(path.join(dir, "outcomes.jsonl")) ? path.join(dir, "outcomes.jsonl") : path.join(dir, "sample-outcomes.jsonl");
  return {
    sessions: [
      ...readJsonl(path.join(dir, "normalized-sessions.jsonl")),
      ...readJsonl(path.join(dir, "sessions.jsonl")),
      ...normalize(readJsonl(full), "codex", {}, path.basename(path.resolve(dir))),
    ],
    outcomes: readJsonl(outcomes),
  };
}

function reportData(dirs: string[], groupBy?: string): Record<string, unknown> {
  const sessions = dirs.flatMap((dir) => rows(dir).sessions);
  const outcomes = dirs.flatMap((dir) => rows(dir).outcomes);
  const outcomesBySession = new Map<string, Record<string, unknown>[]>();
  for (const outcome of outcomes) {
    const key = String(outcome.session_id ?? "unknown");
    outcomesBySession.set(key, [...(outcomesBySession.get(key) ?? []), outcome]);
  }
  const success = outcomes.filter((outcome) => outcome.result === "success").length;
  const groups = new Map<string, { sessions: number; outcomes: number; success: number; tools: number[]; rework: number }>();
  const groupValue = (session: Record<string, unknown>, sessionOutcomes: Record<string, unknown>[]): string => {
    if (!groupBy) return "all";
    if (groupBy === "source") return String(session.source_id ?? "unknown");
    if (groupBy === "skill_id") return Array.isArray(session.skill_ids) && session.skill_ids.length ? session.skill_ids.join(",") : "unknown";
    if (groupBy === "task_type") return String(sessionOutcomes.find((outcome) => outcome.task_type)?.task_type ?? "unknown");
    return String(session[groupBy] ?? "unknown");
  };
  for (const session of sessions) {
    const sessionOutcomes = outcomesBySession.get(String(session.session_id ?? "unknown")) ?? [];
    const key = cleanLabel(groupValue(session, sessionOutcomes));
    const entry = groups.get(key) ?? { sessions: 0, outcomes: 0, success: 0, tools: [], rework: 0 };
    entry.sessions += 1;
    entry.outcomes += sessionOutcomes.length;
    entry.success += sessionOutcomes.filter((outcome) => outcome.result === "success").length;
    if (session.tool_invocations !== undefined && session.tool_invocations !== null) entry.tools.push(Number(session.tool_invocations));
    entry.rework += sessionOutcomes.filter((outcome) => outcome.rework_required).length;
    groups.set(key, entry);
  }
  const sessionIdsWithOutcomes = new Set(outcomes.map((outcome) => outcome.session_id));
  const avgTools = sessions.length ? sessions.reduce((total, session) => total + Number(session.tool_invocations ?? 0), 0) / sessions.length : null;
  const reworkCount = outcomes.filter((outcome) => outcome.rework_required).length;
  return {
    summary: {
      sessions: sessions.length,
      sessions_with_outcomes: sessionIdsWithOutcomes.size,
      outcomes: outcomes.length,
      success_rate: outcomes.length ? success / outcomes.length : null,
      avg_tool_invocations: avgTools,
      rework_rate: outcomes.length ? reworkCount / outcomes.length : null,
    },
    sources: Array.from(new Set(sessions.map((session) => String(session.source_id ?? "unknown")))).sort(),
    groups: Array.from(groups, ([key, entry]) => ({
      key,
      group: key,
      name: key,
      sessions: entry.sessions,
      outcomes: entry.outcomes,
      success_rate: entry.outcomes ? entry.success / entry.outcomes : null,
      avg_tool_invocations: entry.tools.length ? entry.tools.reduce((a, b) => a + b, 0) / entry.tools.length : null,
      rework_rate: entry.outcomes ? entry.rework / entry.outcomes : null,
    })).sort((a, b) => String(a.key).localeCompare(String(b.key))),
  };
}

function reportPath(output: string | undefined, dir: string, force: boolean): string | undefined {
  if (!output) return undefined;
  const reports = path.join(dir, "reports");
  if (fs.existsSync(reports) && fs.lstatSync(reports).isSymbolicLink()) throw new Error("reports directory is symlinked");
  let relativeOutput = output.replace(new RegExp(`^${path.basename(dir)}/reports/`), "").replace(/^reports\//, "");
  let target = path.isAbsolute(output) ? output : path.join(reports, relativeOutput);
  target = path.resolve(target);
  if (!target.startsWith(path.resolve(reports) + path.sep)) throw new Error("report output must be inside telemetry reports directory");
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error("report output is symlinked");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (fs.existsSync(target) && !force) throw new Error("report output exists; rerun with --force");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

function html(content: string): string {
  return `<!doctype html><html><body><h1>Usage Dashboard</h1><h2>What Needs Attention</h2><h2>Measurement state</h2><h2>Data Coverage</h2><h2>Outcome Mix</h2><h2>Missing Label Drilldown</h2><pre>${escapeHtml(content)}</pre></body></html>`;
}

function cleanLabel(value: unknown): string {
  return String(value ?? "unknown").replace(/[\r\n\t\x00-\x1f]+/g, " ").split(/\s+/).filter(Boolean).join(" ") || "unknown";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownCell(value: unknown): string {
  return cleanLabel(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function fmtRate(value: unknown): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function fmtNum(value: unknown): string {
  return typeof value === "number" ? String(Number.isInteger(value) ? value : Number(value.toFixed(2))) : "n/a";
}

function markdownReport(data: Record<string, unknown>, groupBy?: string): string {
  const summary = data.summary as Record<string, unknown>;
  const groups = data.groups as Record<string, unknown>[];
  const lines = [
    "# Agent Usage Feedback Report",
    "",
    "## Summary",
    "",
    `- Sessions: ${summary.sessions}`,
    `- Sessions with outcomes: ${summary.sessions_with_outcomes}`,
    `- Success rate: ${fmtRate(summary.success_rate)}`,
    `- Avg tool invocations: ${fmtNum(summary.avg_tool_invocations)}`,
    `- Rework rate: ${fmtRate(summary.rework_rate)}`,
  ];
  if (groupBy) {
    lines.push("", `## Groups by ${groupBy}`, "", "| Group | Sessions | Outcomes | Success rate | Avg tool invocations | Rework rate |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const group of groups) {
      lines.push(`| ${markdownCell(group.key)} | ${group.sessions} | ${group.outcomes} | ${fmtRate(group.success_rate)} | ${fmtNum(group.avg_tool_invocations)} | ${fmtRate(group.rework_rate)} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function report(argv: string[]): number {
  const { flags } = parseArgs(argv);
  const dirs = flagList(flags, "telemetry-dir").map((dir) => path.resolve(dir));
  dirs.forEach(ensureSafeDir);
  const data = reportData(dirs, flagString(flags, "group-by"));
  const format = flagString(flags, "format", "markdown");
  const out = reportPath(flagString(flags, "output"), dirs[0], flagBool(flags, "force"));
  let body: string;
  if (format === "json") body = JSON.stringify(data, null, 2);
  else if (format === "html") body = html(JSON.stringify(data));
  else body = markdownReport(data, flagString(flags, "group-by"));
  if (out) fs.writeFileSync(out, body, "utf8");
  else console.log(body);
  return 0;
}

function dashboard(argv: string[]): number {
  const { flags } = parseArgs(argv);
  syncArtifacts(argv);
  const dir = telemetryDir(flags);
  const out = reportPath(flagString(flags, "output", "dashboard.html"), dir, flagBool(flags, "force"))!;
  const outcomes = readJsonl(path.join(dir, "outcomes.jsonl"));
  fs.writeFileSync(out, html(outcomes.map((o) => String(o.task_slug)).join("\n")), "utf8");
  if (!flagBool(flags, "quiet")) console.log(`dashboard written to ${out}`);
  return 0;
}

function registerProject(argv: string[]): number {
  const { flags } = parseArgs(argv);
  const globalDir = path.resolve(flagString(flags, "global-dir", path.join(os.homedir(), ".local", "share", "flow-agents", "usage-feedback")) ?? "");
  ensureSafeDir(globalDir);
  const repoRoot = path.resolve(flagString(flags, "repo-root", ".") ?? ".");
  const name = flagString(flags, "name", path.basename(repoRoot)) ?? path.basename(repoRoot);
  const record = { name, repo_root: repoRoot, artifact_dir: path.join(repoRoot, ".flow-agents"), input_telemetry_dir: path.join(repoRoot, ".telemetry"), runtime: flagString(flags, "runtime", "codex"), repo: flagString(flags, "repo", name), agent: flagString(flags, "agent"), profile_id: flagString(flags, "profile-id"), prompt_id: flagString(flags, "prompt-id"), prompt_variant: flagString(flags, "prompt-variant"), skill_ids: flagList(flags, "skill-id"), skill_variant: flagString(flags, "skill-variant") };
  const registryFile = path.join(globalDir, "projects.json");
  const existing = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, "utf8")) : { projects: [] };
  const projects = Array.isArray(existing) ? existing : Array.isArray(existing.projects) ? existing.projects : [];
  const index = projects.findIndex((project: Record<string, unknown>) => project.name === name || project.repo_root === repoRoot);
  if (index >= 0) projects[index] = { ...projects[index], ...record };
  else projects.push(record);
  fs.writeFileSync(registryFile, `${JSON.stringify({ projects }, null, 2)}\n`, "utf8");
  console.log(`registered ${record.name} in ${path.join(globalDir, "projects.json")}`);
  return 0;
}

function loadProjects(globalDir: string): Record<string, unknown>[] {
  const file = path.join(globalDir, "projects.json");
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(data) ? data : Array.isArray(data.projects) ? data.projects : [];
}

function syncProject(project: Record<string, unknown>, globalDir: string): void {
  const name = String(project.name ?? project.repo ?? "project").replace(/[^a-zA-Z0-9_.-]+/g, "-") || "project";
  const store = path.join(globalDir, "projects", name);
  ensureSafeDir(store);
  const artifactDir = String(project.artifact_dir ?? path.join(String(project.repo_root), ".flow-agents"));
  const flags: Record<string, string | boolean | string[]> = {
    "repo": String(project.repo ?? name),
    "runtime": String(project.runtime ?? "codex"),
    "agent": project.agent ? String(project.agent) : "",
    "profile-id": project.profile_id ? String(project.profile_id) : "",
    "prompt-id": project.prompt_id ? String(project.prompt_id) : "",
    "prompt-variant": project.prompt_variant ? String(project.prompt_variant) : "",
    "skill-id": Array.isArray(project.skill_ids) ? project.skill_ids.map(String) : [],
    "skill-variant": project.skill_variant ? String(project.skill_variant) : "",
    "include-open": true,
  };
  const outcomes = fs.existsSync(artifactDir) ? artifactOutcomes(artifactDir, flags) : [];
  writeJsonlUpsert(path.join(store, "outcomes.jsonl"), outcomes, "outcome_id");
}

function discoverProjects(root: string): Record<string, unknown>[] {
  if (!fs.existsSync(root)) return [];
  const candidates = [root, ...fs.readdirSync(root).map((name) => path.join(root, name))];
  return candidates.filter((candidate) => fs.existsSync(path.join(candidate, ".flow-agents"))).map((repoRoot) => {
    const name = path.basename(repoRoot);
    return { name, repo: name, repo_root: repoRoot, artifact_dir: path.join(repoRoot, ".flow-agents"), input_telemetry_dir: path.join(repoRoot, ".telemetry"), runtime: "codex", skill_ids: [] };
  });
}

function syncProjects(argv: string[]): number {
  const { flags } = parseArgs(argv);
  const globalDir = path.resolve(flagString(flags, "global-dir", path.join(os.homedir(), ".local", "share", "flow-agents", "usage-feedback")) ?? "");
  ensureSafeDir(globalDir);
  if (flagString(flags, "repo-root")) registerProject(argv);
  for (const project of loadProjects(globalDir)) syncProject(project, globalDir);
  return 0;
}

function globalDashboard(argv: string[]): number {
  const { flags } = parseArgs(argv);
  const globalDir = path.resolve(flagString(flags, "global-dir", path.join(os.homedir(), ".local", "share", "flow-agents", "usage-feedback")) ?? "");
  ensureSafeDir(globalDir);
  const discovered = flagList(flags, "discover").flatMap(discoverProjects);
  if (discovered.length) {
    const existing = loadProjects(globalDir);
    const merged = [...existing];
    for (const project of discovered) if (!merged.some((item) => item.name === project.name || item.repo_root === project.repo_root)) merged.push(project);
    fs.writeFileSync(path.join(globalDir, "projects.json"), `${JSON.stringify({ projects: merged }, null, 2)}\n`, "utf8");
  }
  for (const project of loadProjects(globalDir)) syncProject(project, globalDir);
  const dirs = fs.existsSync(path.join(globalDir, "projects")) ? fs.readdirSync(path.join(globalDir, "projects")).map((name) => path.join(globalDir, "projects", name)) : [];
  const data = reportData(dirs, "repo");
  const out = reportPath(flagString(flags, "output", "global-dashboard.html"), globalDir, flagBool(flags, "force"))!;
  const projectNames = loadProjects(globalDir).map((project) => String(project.name ?? project.repo ?? "")).filter(Boolean).join("\n");
  fs.writeFileSync(out, html(`${markdownReport(data, "repo")}\n${projectNames}`), "utf8");
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const [command, ...rest] = argv;
    if (command === "record-outcome") return recordOutcome(rest);
    if (command === "import-codex") return importTelemetry(rest, "codex");
    if (command === "import-telemetry") return importTelemetry(rest);
    if (command === "sync-artifacts") return syncArtifacts(rest);
    if (command === "report") return report(rest);
    if (command === "dashboard") return dashboard(rest);
    if (command === "register-project") return registerProject(rest);
    if (command === "sync-projects") return syncProjects(rest);
    if (command === "global-dashboard") return globalDashboard(rest);
    console.error("usage-feedback command required");
    return 2;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
