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
  private _sessionStartMs: number | null = null;

  constructor(options: FlowAgentsHooksOptions = {}) {
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
