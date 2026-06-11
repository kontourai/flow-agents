/**
 * @kontourai/flow-agents-strands
 *
 * Native-import TypeScript adapter for AWS Strands Agents.
 *
 * Wires Flow Agents policy engine directly into Strands hook callbacks without
 * spawning a subprocess. This is the first native-import consumer of the Flow
 * Agents policy engine contract.
 */

export { FlowAgentsHooks } from "./hooks.js";
export type {
  FlowAgentsHooksOptions,
  HookRegistry,
  StrandsEvent,
} from "./hooks.js";

export { TelemetrySink, STRANDS_TO_CANONICAL, normalizeToolName, SCHEMA_VERSION } from "./telemetry.js";
export type { TelemetrySinkOptions, TelemetryEvent } from "./telemetry.js";

export { PolicyGate, PROTECTED_FILES } from "./policy.js";
export type { PolicyGateOptions } from "./policy.js";
