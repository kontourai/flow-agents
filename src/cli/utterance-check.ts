import * as fs from "node:fs";
import * as path from "node:path";
import { flagBool, flagString, parseArgs } from "../lib/args.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

interface StatementResult {
  excerpt: string;
  badge: string;
  target: { subjectType: string; subjectId: string; fieldOrBehavior: string };
  span?: { start: number; end: number };
}

interface UtteranceReport {
  status: "ok" | "not_configured" | "error";
  agent_id: string;
  utterance_excerpt: string;
  statements: StatementResult[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Survey module interface (mirrors @kontourai/survey exported shapes)
// ---------------------------------------------------------------------------

interface SurveyExtractedItem {
  target: { subjectType: string; subjectId: string; fieldOrBehavior: string };
  value?: unknown;
  excerpt: string;
  span?: { start: number; end: number };
  confidence: number;
}

interface SurveyExtractor {
  name: string;
  extract(utterance: string): SurveyExtractedItem[] | Promise<SurveyExtractedItem[]>;
}

interface SurveyStatementItem {
  excerpt: string;
  badge: string;
  target: { subjectType: string; subjectId: string; fieldOrBehavior: string };
  span?: { start: number; end: number };
  inquiryRecord: Record<string, unknown>;
}

interface SurveyTrustReport {
  source: Record<string, unknown>;
  statements: SurveyStatementItem[];
}

interface SurveyMod {
  surveyAgentUtterance: (
    utterance: string,
    extractor: SurveyExtractor,
    context: { bundle: Record<string, unknown>; agentId: string; now?: Date }
  ) => Promise<SurveyTrustReport>;
  referenceUtteranceExtractor: SurveyExtractor;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(): void {
  console.error(
    [
      "usage: flow-agents utterance-check check [options]",
      "",
      "Check an agent utterance for evidence coverage using @kontourai/survey.",
      "Requires @kontourai/survey to be installed in the target workspace.",
      "",
      "Options:",
      "  --utterance TEXT      Utterance text to check (required unless --not-configured).",
      "  --bundle-path FILE    Trust bundle JSON file. Omit for an empty bundle (all unsupported).",
      "  --agent-id ID         Agent identifier for provenance (default: flow-agents-utterance-check).",
      "  --not-configured      Skip survey call; output not_configured without error.",
      "  --strict              Exit non-zero when any badge is disputed, rejected, or unsupported.",
      "  --help                Show this help.",
    ].join("\n")
  );
}

function excerptText(text: string, maxLen = 200): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 3)}...` : trimmed;
}

function badgeSummary(statements: StatementResult[]): string {
  if (statements.length === 0) return "no factual statements extracted";
  const counts: Record<string, number> = {};
  for (const s of statements) {
    counts[s.badge] = (counts[s.badge] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([badge, n]) => `${badge}:${n}`)
    .join(", ");
}

function hasConcerningBadge(badge: string): boolean {
  return badge === "disputed" || badge === "rejected" || badge === "unsupported";
}

async function loadSurvey(): Promise<SurveyMod | undefined> {
  try {
    const pkg = "@kontourai/survey";
    // Dynamic import avoids a static dependency on @kontourai/survey —
    // the same pattern survey/src/anthropic.ts uses for @anthropic-ai/sdk.
    const mod = await (Function("m", "return import(m)")(pkg) as Promise<unknown>);
    return mod as SurveyMod;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

async function runCheck(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);

  if (flagBool(flags, "help")) {
    usage();
    return 0;
  }

  const agentId = flagString(flags, "agent-id") ?? "flow-agents-utterance-check";
  const notConfigured = flagBool(flags, "not-configured");
  const strict = flagBool(flags, "strict");

  if (notConfigured) {
    const report: UtteranceReport = {
      status: "not_configured",
      agent_id: agentId,
      utterance_excerpt: "",
      statements: [],
      summary: "@kontourai/survey is not configured for this workspace.",
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const utterance = flagString(flags, "utterance");
  if (!utterance) {
    usage();
    return 3;
  }

  const bundlePath = flagString(flags, "bundle-path");
  let bundle: Record<string, unknown> = { claims: [] };
  if (bundlePath) {
    const resolved = path.resolve(bundlePath);
    try {
      const raw = fs.readFileSync(resolved, "utf8");
      bundle = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[UtteranceCheck] could not read bundle from ${resolved}: ${msg}\n`);
    }
  }

  const survey = await loadSurvey();
  if (!survey) {
    const report: UtteranceReport = {
      status: "not_configured",
      agent_id: agentId,
      utterance_excerpt: excerptText(utterance),
      statements: [],
      summary: "@kontourai/survey is not installed. Install it or run with --not-configured.",
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      "[UtteranceCheck] not_configured: @kontourai/survey is not installed in this workspace.\n"
    );
    return 1;
  }

  const { surveyAgentUtterance, referenceUtteranceExtractor } = survey;

  let trustReport: SurveyTrustReport;
  try {
    trustReport = await surveyAgentUtterance(utterance, referenceUtteranceExtractor, {
      bundle,
      agentId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const report: UtteranceReport = {
      status: "error",
      agent_id: agentId,
      utterance_excerpt: excerptText(utterance),
      statements: [],
      summary: `Survey call failed: ${msg}`,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`[UtteranceCheck] survey call failed: ${msg}\n`);
    return 1;
  }

  const statements: StatementResult[] = trustReport.statements.map((s) => ({
    excerpt: s.excerpt,
    badge: s.badge,
    target: s.target,
    span: s.span,
  }));

  const summary = badgeSummary(statements);
  const report: UtteranceReport = {
    status: "ok",
    agent_id: agentId,
    utterance_excerpt: excerptText(utterance),
    statements,
    summary,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const concerning = statements.filter((s) => hasConcerningBadge(s.badge));
  if (concerning.length > 0) {
    process.stderr.write(
      `[UtteranceCheck] ${concerning.length} statement(s) lack evidence coverage: ${summary}\n`
    );
    for (const s of concerning.slice(0, 4)) {
      process.stderr.write(`  - [${s.badge}] "${excerptText(s.excerpt, 100)}"\n`);
    }
  }

  if (strict && concerning.length > 0) return 2;
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    usage();
    return 0;
  }
  if (subcommand !== "check") {
    console.error(`Unknown utterance-check subcommand: ${subcommand}`);
    usage();
    return 3;
  }
  return runCheck(rest);
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
