/**
 * hooks.ts — FlowAgentsHooks: the main hook provider for Strands Agents TypeScript SDK.
 *
 * Design: duck-typed against the Strands TS registry/event shapes so the module
 * compiles and tests WITHOUT strands-agents installed. strands-agents is listed
 * as an optional peerDependency in package.json.
 *
 * When strands-agents IS installed, FlowAgentsHooks is a valid HookProvider
 * because it implements registerHooks(registry) which calls:
 *   registry.addCallback(EventClass, callback)
 *
 * Usage (with strands-agents installed):
 *
 *   import { Agent, BeforeInvocationEvent, AfterInvocationEvent,
 *            BeforeToolCallEvent, AfterToolCallEvent } from "@strands-agents/sdk";
 *   import { FlowAgentsHooks } from "@kontourai/flow-agents-strands";
 *
 *   const hooks = new FlowAgentsHooks({ workspace: "." });
 *   const agent = new Agent({ hooks: [hooks] });
 *   // or: agent.addHook(BeforeInvocationEvent, cb);
 *
 * Usage (without strands-agents, e.g. tests):
 *
 *   import { FlowAgentsHooks } from "@kontourai/flow-agents-strands";
 *   const hooks = new FlowAgentsHooks();
 *   // All methods callable; registerHooks() is a no-op without the SDK.
 */

import fs from "node:fs";
import path from "node:path";
import { TelemetrySink } from "./telemetry.js";
import { PolicyGate } from "./policy.js";

// ---------------------------------------------------------------------------
// Duck-typed Strands registry/event interfaces
// These match the Strands TS SDK surface structurally; we do NOT import the
// actual SDK so the module compiles without it being installed.
// ---------------------------------------------------------------------------

/** Minimal duck-type for a Strands-TS event class constructor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventClass = new (...args: any[]) => unknown;

/** Minimal duck-type for a Strands-TS HookRegistry. */
export interface HookRegistry {
  addCallback(eventClass: EventClass, callback: (event: StrandsEvent) => void): void;
}

/** Minimal duck-type for Strands events we handle. */
export interface StrandsEvent {
  // BeforeToolCallEvent fields
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // TS variant: cancellable via cancel property
  cancel?: string;
  // AfterToolCallEvent
  retry?: boolean;
  result?: unknown;
  // Common optional fields
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Kit flow discovery (Issue #32, Decision Q3: option (a))
//
// activateStrandsLocal (src/runtime-adapters.ts) writes kit flow files to
// .flow-agents/runtime/strands/flows/<kit-id>/<asset-id>.flow.json.
// steeringContext() reads those files and surfaces their id + description
// so the agent is aware of available workflow guidance without the hooks
// needing to know anything about the catalog layout.
// ---------------------------------------------------------------------------

interface KitFlowEntry {
  kitId: string;
  assetId: string;
  description: string;
}

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (
      fs.existsSync(path.join(current, ".git")) ||
      fs.existsSync(path.join(current, "AGENTS.md"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start);
}

function readKitFlows(flowAgentsDir: string): KitFlowEntry[] {
  const flowsDir = path.join(flowAgentsDir, "runtime", "strands", "flows");
  if (!fs.existsSync(flowsDir)) return [];
  const results: KitFlowEntry[] = [];

  function walkDir(dir: string): void {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walkDir(full);
      } else if (name.endsWith(".flow.json")) {
        try {
          const payload = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
          const stemName = name.replace(/\.flow\.json$/, "");
          const assetId = typeof payload.id === "string" ? payload.id : stemName;
          const description = typeof payload.description === "string" ? payload.description : "";
          // kit_id is the directory component between flows/ and the file
          const rel = path.relative(flowsDir, full);
          const relParts = rel.split(path.sep);
          const kitId = relParts.length >= 2 ? relParts[0] : "";
          results.push({ kitId, assetId, description });
        } catch {
          // Malformed file — skip silently (fail-open)
        }
      }
    }
  }

  walkDir(flowsDir);
  return results;
}

function buildKitFlowsHint(flows: KitFlowEntry[]): string {
  if (flows.length === 0) return "";
  const lines = ["KIT FLOWS: the following kit flows are activated for this workspace:"];
  for (const flow of flows) {
    const desc = flow.description ? ` — ${flow.description.slice(0, 120)}` : "";
    lines.push(`  • ${flow.assetId}${desc}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// FlowAgentsHooks options
// ---------------------------------------------------------------------------

export interface FlowAgentsHooksOptions {
  /** JSONL telemetry sink path or directory. Default: <workspace>/.telemetry/full.jsonl */
  sinkPath?: string;
  /** Root of the workspace (reads .flow-agents/ and .telemetry/). Default: process.cwd() */
  workspace?: string;
  /** Agent identifier embedded in telemetry. Default: "strands-agent" */
  agentName?: string;
  /** Runtime label in telemetry. Default: "strands-ts" */
  runtime?: string;
  /**
   * Root of the @kontourai/flow-agents package for native engine import.
   * Defaults to auto-discovery (see policy.ts).
   */
  engineRoot?: string;
}

// ---------------------------------------------------------------------------
// FlowAgentsHooks
// ---------------------------------------------------------------------------

export class FlowAgentsHooks {
  private readonly sink: TelemetrySink;
  private readonly policyGate: PolicyGate;
  private readonly _workspace: string;
  private _sessionStartMs: number | null = null;

  constructor(options: FlowAgentsHooksOptions = {}) {
    this._workspace = findRepoRoot(options.workspace ?? process.cwd());

    this.sink = new TelemetrySink({
      sinkPath: options.sinkPath,
      workspace: options.workspace,
      agentName: options.agentName ?? "strands-agent",
      runtime: options.runtime ?? "strands-ts",
    });

    this.policyGate = new PolicyGate({
      engineRoot: options.engineRoot,
    });
  }

  // --------------------------------------------------------------------------
  // Steering context — available without strands-agents installed (Issue #32 AC2)
  // --------------------------------------------------------------------------

  /**
   * Return workflow-steering context text for the current workspace.
   *
   * Includes activated kit flows discovered from the strands-local runtime
   * path (.flow-agents/runtime/strands/flows/) written by
   * `flow-agents kit activate --adapter strands-local`.
   *
   * Callers should prepend this to the Agent's system prompt:
   *
   *   const hooks = new FlowAgentsHooks({ workspace: "." });
   *   const agent = new Agent({ systemPrompt: basePrompt + hooks.steeringContext() });
   */
  steeringContext(): string {
    const flowAgentsDir = path.join(this._workspace, ".flow-agents");
    const flows = readKitFlows(flowAgentsDir);
    const kitFlowsHint = buildKitFlowsHint(flows);
    if (!kitFlowsHint) return "";
    return "\n\n---\n" + kitFlowsHint + "\n---";
  }

  // --------------------------------------------------------------------------
  // HookProvider protocol — registerHooks(registry)
  // This is the sole method required by the Strands HookProvider protocol.
  // --------------------------------------------------------------------------

  /**
   * Register Flow Agents callbacks with a Strands HookRegistry.
   *
   * Requires strands-agents to be installed. If the SDK is absent,
   * this method throws ImportError with instructions.
   */
  registerHooks(registry: HookRegistry): void {
    // Lazily import Strands event classes. If the SDK is not installed,
    // a helpful error is thrown.
    let BeforeInvocationEvent: EventClass;
    let AfterInvocationEvent: EventClass;
    let BeforeToolCallEvent: EventClass;
    let AfterToolCallEvent: EventClass;

    try {
      // Dynamic import is used so the module compiles without the SDK installed.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require("strands-agents") as {
        BeforeInvocationEvent: EventClass;
        AfterInvocationEvent: EventClass;
        BeforeToolCallEvent: EventClass;
        AfterToolCallEvent: EventClass;
      };
      BeforeInvocationEvent = sdk.BeforeInvocationEvent;
      AfterInvocationEvent = sdk.AfterInvocationEvent;
      BeforeToolCallEvent = sdk.BeforeToolCallEvent;
      AfterToolCallEvent = sdk.AfterToolCallEvent;
    } catch (err) {
      throw new Error(
        "strands-agents is required to register hooks. " +
          "Install it with: npm install @strands-agents/sdk\n" +
          `Original error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    registry.addCallback(BeforeInvocationEvent, (event) => this.onBeforeInvocation(event));
    registry.addCallback(AfterInvocationEvent, (event) => this.onAfterInvocation(event));
    registry.addCallback(BeforeToolCallEvent, (event) => this.onBeforeToolCall(event));
    registry.addCallback(AfterToolCallEvent, (event) => this.onAfterToolCall(event));
  }

  // --------------------------------------------------------------------------
  // Callbacks — public for direct wiring in tests / without SDK
  // --------------------------------------------------------------------------

  /** BeforeInvocationEvent → userPromptSubmit / turn.user */
  onBeforeInvocation(_event: StrandsEvent): void {
    if (this._sessionStartMs === null) {
      this._sessionStartMs = Date.now();
    }
    this.sink.emitUserPromptSubmit();
  }

  /** AfterInvocationEvent → stop / session.end */
  onAfterInvocation(_event: StrandsEvent): void {
    const durationMs =
      this._sessionStartMs !== null ? Date.now() - this._sessionStartMs : 0;
    this.sink.emitSessionEnd(durationMs);
  }

  /**
   * BeforeToolCallEvent → preToolUse / tool.invoke + config-protection policy gate.
   *
   * If the policy gate blocks the call, sets event.cancel to the block reason
   * (Strands TS variant: event.cancel = "reason").
   */
  onBeforeToolCall(event: StrandsEvent): void {
    const toolName = (event.toolName as string | undefined) ?? "";
    const toolInput = (event.toolInput as Record<string, unknown> | undefined) ?? {};

    // Emit telemetry first (fail-open: policy check follows)
    this.sink.emitToolInvoke(toolName, toolInput);

    // Policy gate — native engine call (no subprocess)
    const blockReason = this.policyGate.checkToolCall(toolName, toolInput);
    if (blockReason) {
      try {
        event.cancel = blockReason;
      } catch {
        // Some event mock or future SDK change; ignore and continue
      }
    }
  }

  /** AfterToolCallEvent → postToolUse / tool.result */
  onAfterToolCall(event: StrandsEvent): void {
    const toolName = (event.toolName as string | undefined) ?? "";
    const result = event.result;
    this.sink.emitToolResult(toolName, result);
  }

  // --------------------------------------------------------------------------
  // Session start — emit agentSpawn when wiring is complete
  // --------------------------------------------------------------------------

  /** Call once after constructing / wiring to emit the agentSpawn event. */
  emitSessionStart(): void {
    this._sessionStartMs = Date.now();
    this.sink.emitSessionStart();
  }
}
