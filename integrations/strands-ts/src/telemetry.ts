/**
 * telemetry.ts — Canonical Flow Agents telemetry event builder and JSONL sink.
 *
 * Event taxonomy mirrors the JS telemetry hooks exactly.
 * JSONL output is structurally identical to claude-telemetry-hook.js and
 * codex-telemetry-hook.js output.
 *
 * Canonical → schema event_type mapping mirrors _CANONICAL_TO_SCHEMA from
 * integrations/strands/flow_agents_strands/telemetry.py and
 * scripts/telemetry/telemetry.sh schema_event_type().
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Strands TS → canonical event-name mapping
// Mirrors STRANDS_TO_CANONICAL in integrations/strands/flow_agents_strands/telemetry.py
// ---------------------------------------------------------------------------

/**
 * Maps Strands TypeScript event class names to canonical Flow Agents event names.
 * This is the source-of-truth mapping for the TS adapter.
 */
export const STRANDS_TO_CANONICAL: Readonly<Record<string, string>> = {
  // Strands event class name    →  canonical Flow Agents event name
  BeforeInvocationEvent: "userPromptSubmit",
  AfterInvocationEvent: "stop",
  BeforeToolCallEvent: "preToolUse",
  AfterToolCallEvent: "postToolUse",
  AgentInitializedEvent: "agentSpawn",
  AfterModelCallEvent: "postToolUse", // closest analogue; no tool name
  MessageAddedEvent: "userPromptSubmit",
} as const;

// ---------------------------------------------------------------------------
// Canonical → schema event_type
// Mirrors _CANONICAL_TO_SCHEMA in telemetry.py and schema_event_type() in telemetry.sh
// ---------------------------------------------------------------------------

const CANONICAL_TO_SCHEMA: Readonly<Record<string, string>> = {
  agentSpawn: "session.start",
  userPromptSubmit: "turn.user",
  preToolUse: "tool.invoke",
  permissionRequest: "tool.permission_request",
  postToolUse: "tool.result",
  stop: "session.end",
  subagentStart: "agent.delegate",
  subagentStop: "agent.delegate",
} as const;

function schemaEventType(canonical: string): string {
  return CANONICAL_TO_SCHEMA[canonical] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Tool-name normalizer — mirrors _normalize_tool_name in telemetry.py
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  bash: "execute_bash",
  execute_bash: "execute_bash",
  shell: "execute_bash",
  edit: "fs_write",
  write: "fs_write",
  fs_write: "fs_write",
  apply_patch: "fs_write",
  read: "fs_read",
  fs_read: "fs_read",
  task: "use_subagent",
  agent: "use_subagent",
  use_subagent: "use_subagent",
} as const;

export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name.toLowerCase()] ?? name;
}

// ---------------------------------------------------------------------------
// Event shape — mirrors build_base_event() in telemetry.sh
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  schema_version: string;
  timestamp: string;
  session_id: string;
  event_id: string;
  event_type: string;
  agent: {
    name: string;
    runtime: string;
    version: string;
  };
  hook: {
    event_name: string;
    runtime_session_id: string;
    turn_id: string;
    transcript_path: string;
    model: string;
    source: string;
    stop_hook_active: null;
    last_assistant_message: string;
    raw_input: null;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// TelemetrySink
// ---------------------------------------------------------------------------

export interface TelemetrySinkOptions {
  /** Directory or file path for JSONL telemetry output.
   *  Default: <workspace>/.telemetry/full.jsonl */
  sinkPath?: string;
  /** Root of the workspace (for resolving .telemetry/ subdir). Default: cwd */
  workspace?: string;
  /** Agent identifier embedded in telemetry events. Default: "strands-agent" */
  agentName?: string;
  /** Runtime label embedded in telemetry events. Default: "strands-ts" */
  runtime?: string;
}

export const SCHEMA_VERSION = "0.3.0";
const DEFAULT_TELEMETRY_SUBDIR = ".telemetry";
const DEFAULT_FILENAME = "full.jsonl";

export class TelemetrySink {
  private readonly agentName: string;
  private readonly runtime: string;
  private readonly logFile: string;
  private _sessionId: string | null = null;

  constructor(options: TelemetrySinkOptions = {}) {
    this.agentName = options.agentName ?? "strands-agent";
    this.runtime = options.runtime ?? "strands-ts";

    const ws = options.workspace ?? process.cwd();

    if (options.sinkPath) {
      const p = options.sinkPath;
      // If it looks like a directory (no extension), append full.jsonl
      if (!path.extname(p)) {
        this.logFile = path.join(p, DEFAULT_FILENAME);
      } else {
        this.logFile = p;
      }
    } else {
      this.logFile = path.join(ws, DEFAULT_TELEMETRY_SUBDIR, DEFAULT_FILENAME);
    }

    // Ensure parent directory exists
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    } catch {
      // fail-open: telemetry must never block agent work
    }
  }

  get sessionId(): string {
    if (this._sessionId === null) {
      this._sessionId = randomUUID();
    }
    return this._sessionId;
  }

  private buildBaseEvent(schemaEventType: string): TelemetryEvent {
    return {
      schema_version: SCHEMA_VERSION,
      timestamp: String(Date.now()),
      session_id: this.sessionId,
      event_id: randomUUID(),
      event_type: schemaEventType,
      agent: {
        name: this.agentName,
        runtime: this.runtime,
        version: "unknown",
      },
      hook: {
        event_name: "",
        runtime_session_id: "",
        turn_id: "",
        transcript_path: "",
        model: "",
        source: "strands-ts",
        stop_hook_active: null,
        last_assistant_message: "",
        raw_input: null,
      },
    };
  }

  emit(canonicalEvent: string, extra?: Record<string, unknown>): TelemetryEvent {
    const schemaType = schemaEventType(canonicalEvent);
    const event = this.buildBaseEvent(schemaType);

    // Attach hook context — hook.event_name is the canonical name
    event.hook = {
      ...event.hook,
      event_name: canonicalEvent,
    };

    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        event[key] = value;
      }
    }

    try {
      fs.appendFileSync(this.logFile, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // fail-open: telemetry must never block agent work
    }

    return event;
  }

  emitSessionStart(extra?: Record<string, unknown>): TelemetryEvent {
    return this.emit("agentSpawn", extra);
  }

  emitSessionEnd(durationMs?: number): TelemetryEvent {
    const durationS = durationMs != null ? durationMs / 1000 : 0;
    return this.emit("stop", { session: { duration_s: durationS } });
  }

  emitToolInvoke(toolName: string, toolInput?: Record<string, unknown>): TelemetryEvent {
    return this.emit("preToolUse", {
      tool: {
        name: toolName,
        normalized_name: normalizeToolName(toolName),
        input: toolInput ?? null,
      },
    });
  }

  emitToolResult(toolName: string, toolOutput?: unknown): TelemetryEvent {
    return this.emit("postToolUse", {
      tool: {
        name: toolName,
        normalized_name: normalizeToolName(toolName),
        output: toolOutput ?? null,
      },
    });
  }

  emitUserPromptSubmit(extra?: Record<string, unknown>): TelemetryEvent {
    return this.emit("userPromptSubmit", extra);
  }

  /**
   * Emit a `session.usage` event with real token counts + derived cost.
   *
   * The Strands SDK surfaces per-invocation usage on AfterModelCall /
   * AfterInvocation events; accumulate those and pass the totals here at
   * session end. Tokens are the source of truth; estimated_cost_usd is derived
   * from PRICING (the console recomputes it authoritatively, so a pricing
   * change is retroactive). Mirrors the `session.usage` shape emitted by
   * scripts/telemetry/telemetry.sh so the console aggregates both identically.
   */
  emitUsage(usage: UsageInput): TelemetryEvent {
    const event = this.buildBaseEvent("session.usage");
    event.event_id = `${event.event_id}-usage`;
    event.hook = { ...event.hook, event_name: "usage" };

    const byModel = (usage.byModel ?? []).map((entry) => {
      const tokens = normalizeTokens(entry);
      return {
        model: entry.model,
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_creation_input_tokens: tokens.cacheCreation,
        cache_read_input_tokens: tokens.cacheRead,
        estimated_cost_usd: costForModel(entry.model, tokens)
      };
    });

    const flat = normalizeTokens(usage);
    const cost = byModel.length
      ? round6(byModel.reduce((sum, m) => sum + m.estimated_cost_usd, 0))
      : costForModel(usage.model, flat);

    event.usage = {
      model: usage.model ?? this.runtime,
      duration_s: usage.durationS ?? null,
      input_tokens: flat.input,
      output_tokens: flat.output,
      cache_creation_input_tokens: flat.cacheCreation,
      cache_read_input_tokens: flat.cacheRead,
      estimated_cost_usd: cost,
      pricing_version: pricingVersion(),
      by_model: byModel.length ? byModel : null
    };

    try {
      fs.appendFileSync(this.logFile, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // fail-open: telemetry must never block agent work
    }
    return event;
  }
}

// ---------------------------------------------------------------------------
// Usage / cost — mirror of scripts/telemetry/pricing.json (per 1M tokens, USD)
// ---------------------------------------------------------------------------

export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface UsageInput extends TokenCounts {
  model?: string;
  durationS?: number;
  byModel?: Array<TokenCounts & { model: string }>;
}

interface NormalizedTokens {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

// Pricing is read from the single-source registry (scripts/telemetry/pricing.json),
// never hand-maintained here. Resolution: TELEMETRY_PRICING_FILE /
// FLOW_AGENTS_PRICING_FILE env path, else the repo-relative registry, else a
// minimal fallback. Tokens are exact regardless; the console recomputes cost
// authoritatively, so a missing file only degrades the sink's stamped estimate.
interface PricingVersionBlock {
  cache_multipliers: { write_5m: number; write_1h: number; read: number };
  models: Record<string, { input: number; output: number }>;
  default: { input: number; output: number };
  zero_cost_models: string[];
}
interface PricingRegistry {
  current_version: string;
  versions: Record<string, PricingVersionBlock>;
}

const FALLBACK_REGISTRY: PricingRegistry = {
  current_version: "fallback",
  versions: {
    fallback: {
      cache_multipliers: { write_5m: 1.25, write_1h: 2.0, read: 0.1 },
      models: {},
      default: { input: 5.0, output: 25.0 },
      zero_cost_models: ["<synthetic>", "synthetic", "unknown", ""]
    }
  }
};

let cachedRegistry: PricingRegistry | null = null;
function loadRegistry(): PricingRegistry {
  if (cachedRegistry) return cachedRegistry;
  const candidates = [
    process.env.TELEMETRY_PRICING_FILE,
    process.env.FLOW_AGENTS_PRICING_FILE,
    path.join(__dirname, "../../../scripts/telemetry/pricing.json"),
    path.join(__dirname, "../../../../scripts/telemetry/pricing.json")
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed && typeof parsed.current_version === "string" && parsed.versions) {
        cachedRegistry = parsed as PricingRegistry;
        return cachedRegistry;
      }
    } catch {
      // try next candidate
    }
  }
  cachedRegistry = FALLBACK_REGISTRY;
  return cachedRegistry;
}

function pricingVersion(): string {
  return loadRegistry().current_version;
}

function num(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeTokens(tokens: TokenCounts): NormalizedTokens {
  return {
    input: num(tokens.inputTokens),
    output: num(tokens.outputTokens),
    cacheCreation: num(tokens.cacheCreationInputTokens),
    cacheRead: num(tokens.cacheReadInputTokens)
  };
}

function costForModel(model: string | undefined, tokens: NormalizedTokens): number {
  const registry = loadRegistry();
  const block = registry.versions[registry.current_version] ?? FALLBACK_REGISTRY.versions.fallback;
  const key = (model ?? "").trim();
  if (block.zero_cost_models.includes(key)) return 0;
  const rate = block.models[key] ?? block.default;
  const cm = block.cache_multipliers;
  return round6(
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheCreation * rate.input * cm.write_5m +
      tokens.cacheRead * rate.input * cm.read) /
      1_000_000
  );
}
