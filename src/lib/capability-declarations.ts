/**
 * Programmatic runtime capability declarations (#620).
 *
 * The single source of truth for "which agent-runtime telemetry capability does
 * each shipped adapter expose". This replaces the hand-maintained coverage table
 * in docs/specs/harness-capability-matrix.md and the hardcoded emitter `signals`
 * literals: the matrix doc is GENERATED from this module (src/tools/
 * generate-capability-matrix.ts) and the economics-record emitter derives its
 * per_delegation_tokens signal from a build-only JSON projection of it.
 *
 * This module is the declaration/query MECHANISM only (issue #620). It does NOT
 * measure declaration-vs-runtime reality (a NON-GOAL), and it does NOT implement
 * the capabilities themselves (intent capture #622, trace propagation #425) — it
 * declares whether each runtime exposes them so consumers can distinguish a real
 * zero from a harness-blind gap, and returns a TYPED `unsupported` for an
 * undeclared runtime or capability rather than a fabricated default.
 *
 * PURE: no fs / net / process imports. Safe to import from hooks, compilers,
 * evals, and generators alike.
 *
 * @module
 */

/** The six declared per-runtime capabilities (R1/#620). */
export const CAPABILITIES = [
  "turn_id",
  "transcript_path",
  "intent_annotation",
  "per_delegation_trace_context",
  "per_delegation_tokens",
  "terminal_verdict",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The seven shipped adapters (R1). The first five are agent runtimes; the last
 * two (codex-local, strands-local) are kit-ACTIVATION adapters on a different
 * axis from agent-runtime telemetry — they declare their agent-runtime telemetry
 * capabilities honestly (mostly `unsupported`), satisfying R1 literally without
 * fabricating support they do not have.
 */
export const RUNTIME_ADAPTER_IDS = [
  "claude-code",
  "codex",
  "kiro",
  "opencode",
  "pi",
  "codex-local",
  "strands-local",
] as const;

export type RuntimeAdapterId = (typeof RUNTIME_ADAPTER_IDS)[number];

/**
 * Per-capability status as a discriminated union (D3). Richer than a bare
 * boolean: `partial` carries a `note`, `unsupported` carries a `reason`, so R4's
 * explicit `unsupported` sentinel always travels with a justification and a
 * consumer never has to invent one.
 */
export type CapabilityStatus =
  | { readonly status: "supported" }
  | { readonly status: "partial"; readonly note: string }
  | { readonly status: "unsupported"; readonly reason: string };

/** A runtime's full declaration: the canonical id + all six capability statuses. */
export interface RuntimeCapabilityDeclaration {
  readonly runtime: RuntimeAdapterId;
  readonly capabilities: Readonly<Record<Capability, CapabilityStatus>>;
}

// --- status constructors (local, keep the declaration table terse + honest) ---
const supported = (): CapabilityStatus => ({ status: "supported" });
const partial = (note: string): CapabilityStatus => ({ status: "partial", note });
const unsupported = (reason: string): CapabilityStatus => ({ status: "unsupported", reason });

// Reasons shared across every adapter for the three capabilities that no runtime
// exposes today (kept single-sourced so the declarations stay consistent).
const NOT_IMPLEMENTED_INTENT = unsupported(
  "Intent-annotation capture is not implemented on any runtime yet (#622).",
);
const NOT_IMPLEMENTED_TRACE = unsupported(
  "Per-delegation trace-context propagation is not implemented on any runtime yet (#425).",
);
const NO_PER_DELEGATION_TOKENS = unsupported(
  "No runtime isolates per-sub-agent token usage; per-delegation cost is attributed at (role, model) granularity instead.",
);
const VERDICT_WORKFLOW_PARTIAL = partial(
  "Captured only when the workflow records an evidence/verdict event for the sub-agent — not guaranteed every run.",
);
const KIT_ADAPTER_TURN = (adapter: string): CapabilityStatus =>
  unsupported(`${adapter} is a kit-activation adapter, not an agent-runtime telemetry source; it emits no per-turn agent-runtime telemetry.`);
const KIT_ADAPTER_TRANSCRIPT = (adapter: string): CapabilityStatus =>
  unsupported(`${adapter} is a kit-activation adapter and does not expose a per-session transcript path.`);
const KIT_ADAPTER_VERDICT = (adapter: string): CapabilityStatus =>
  unsupported(`${adapter} is a kit-activation adapter and does not surface per-sub-agent terminal verdicts.`);

/**
 * The canonical declaration data — the single source of truth. Every adapter
 * declares ALL six capabilities explicitly (conformance-enforced; no defaulting).
 */
export const RUNTIME_CAPABILITY_DECLARATIONS: Readonly<Record<RuntimeAdapterId, RuntimeCapabilityDeclaration>> = {
  "claude-code": {
    runtime: "claude-code",
    capabilities: {
      turn_id: supported(),
      transcript_path: supported(),
      intent_annotation: NOT_IMPLEMENTED_INTENT,
      per_delegation_trace_context: NOT_IMPLEMENTED_TRACE,
      per_delegation_tokens: NO_PER_DELEGATION_TOKENS,
      terminal_verdict: VERDICT_WORKFLOW_PARTIAL,
    },
  },
  codex: {
    runtime: "codex",
    capabilities: {
      turn_id: supported(),
      transcript_path: supported(),
      intent_annotation: NOT_IMPLEMENTED_INTENT,
      per_delegation_trace_context: NOT_IMPLEMENTED_TRACE,
      per_delegation_tokens: NO_PER_DELEGATION_TOKENS,
      terminal_verdict: unsupported(
        "Codex does not surface a per-sub-agent terminal verdict to the orchestrator.",
      ),
    },
  },
  kiro: {
    runtime: "kiro",
    capabilities: {
      turn_id: supported(),
      transcript_path: supported(),
      intent_annotation: NOT_IMPLEMENTED_INTENT,
      per_delegation_trace_context: NOT_IMPLEMENTED_TRACE,
      per_delegation_tokens: NO_PER_DELEGATION_TOKENS,
      terminal_verdict: VERDICT_WORKFLOW_PARTIAL,
    },
  },
  opencode: {
    runtime: "opencode",
    capabilities: {
      turn_id: partial(
        "session.start telemetry is unavailable in opencode run (non-interactive) mode; tool events still carry a turn context.",
      ),
      transcript_path: unsupported(
        "opencode does not expose a per-session transcript path to hooks.",
      ),
      intent_annotation: NOT_IMPLEMENTED_INTENT,
      per_delegation_trace_context: NOT_IMPLEMENTED_TRACE,
      per_delegation_tokens: NO_PER_DELEGATION_TOKENS,
      terminal_verdict: unsupported(
        "opencode does not surface per-sub-agent terminal verdicts.",
      ),
    },
  },
  pi: {
    runtime: "pi",
    capabilities: {
      turn_id: supported(),
      transcript_path: unsupported(
        "pi does not expose a per-session transcript path to hooks.",
      ),
      intent_annotation: NOT_IMPLEMENTED_INTENT,
      per_delegation_trace_context: NOT_IMPLEMENTED_TRACE,
      per_delegation_tokens: NO_PER_DELEGATION_TOKENS,
      terminal_verdict: unsupported(
        "pi has no named-subagent registry, so per-sub-agent verdicts are not observable.",
      ),
    },
  },
  "codex-local": {
    runtime: "codex-local",
    capabilities: {
      turn_id: KIT_ADAPTER_TURN("codex-local"),
      transcript_path: KIT_ADAPTER_TRANSCRIPT("codex-local"),
      intent_annotation: NOT_IMPLEMENTED_INTENT,
      per_delegation_trace_context: NOT_IMPLEMENTED_TRACE,
      per_delegation_tokens: NO_PER_DELEGATION_TOKENS,
      terminal_verdict: KIT_ADAPTER_VERDICT("codex-local"),
    },
  },
  "strands-local": {
    runtime: "strands-local",
    capabilities: {
      turn_id: KIT_ADAPTER_TURN("strands-local"),
      transcript_path: KIT_ADAPTER_TRANSCRIPT("strands-local"),
      intent_annotation: NOT_IMPLEMENTED_INTENT,
      per_delegation_trace_context: NOT_IMPLEMENTED_TRACE,
      per_delegation_tokens: NO_PER_DELEGATION_TOKENS,
      terminal_verdict: KIT_ADAPTER_VERDICT("strands-local"),
    },
  },
};

/**
 * Alias → canonical-runtime-id map (D1). The load-bearing entry is
 * `kiro-cli → kiro`: the value `.agent.runtime` carries for Kiro is `kiro-cli`,
 * but declarations are keyed on the canonical `kiro`. Keys are the already
 * lowercased + whitespace-collapsed form.
 */
export const RUNTIME_ID_ALIASES: Readonly<Record<string, string>> = {
  "kiro-cli": "kiro",
  "raw-model": "base",
  "raw-model-runner": "base",
};

/**
 * Normalize any raw runtime spelling to its canonical key (D1). Total + pure:
 * trims, lowercases, collapses internal whitespace to hyphens, then folds known
 * aliases (notably `kiro-cli → kiro`). Returns `""` for a null/blank input.
 * The canonical id may still be undeclared (e.g. `base`) — that is intentional
 * and resolves to a typed `unsupported` at query time, never a fabricated value.
 */
export function normalizeRuntimeId(raw: string | null | undefined): string {
  const lowered = String(raw ?? "").trim().toLowerCase();
  if (!lowered) return "";
  const collapsed = lowered.replace(/\s+/g, "-");
  // Object.hasOwn guards against prototype-member keys (`__proto__`,
  // `constructor`, `toString`, …): a bare bracket lookup would resolve those to
  // inherited Object.prototype members instead of `undefined`, breaking the
  // total-string contract. Own-property only; unknown keys fall through.
  return Object.hasOwn(RUNTIME_ID_ALIASES, collapsed) ? RUNTIME_ID_ALIASES[collapsed] : collapsed;
}

/** Return the full declaration for a runtime (after alias normalization), or `undefined`. */
export function getDeclaration(runtimeId: string | null | undefined): RuntimeCapabilityDeclaration | undefined {
  const canonical = normalizeRuntimeId(runtimeId);
  return Object.hasOwn(RUNTIME_CAPABILITY_DECLARATIONS, canonical)
    ? (RUNTIME_CAPABILITY_DECLARATIONS as Record<string, RuntimeCapabilityDeclaration>)[canonical]
    : undefined;
}

/**
 * Query a single capability for a runtime (D5). ALWAYS returns a typed
 * `CapabilityStatus` — never `undefined`/`false`. An undeclared runtime OR an
 * undeclared capability returns `{status:"unsupported", reason}` (R4): the
 * JS-natural undefined/false fallback is exactly the fabrication R4 forbids.
 */
export function queryCapability(runtimeId: string | null | undefined, capability: string): CapabilityStatus {
  const canonical = normalizeRuntimeId(runtimeId);
  const declaration = getDeclaration(canonical);
  if (!declaration) {
    return {
      status: "unsupported",
      reason: `No capability declaration for runtime '${canonical || String(runtimeId ?? "")}'.`,
    };
  }
  // Own-property guard: a prototype-member capability name (`constructor`,
  // `__proto__`, …) must resolve to a typed `unsupported`, not an inherited
  // Object.prototype value (a function / the prototype object) that is not a
  // CapabilityStatus at all.
  const status = Object.hasOwn(declaration.capabilities, capability)
    ? (declaration.capabilities as Record<string, CapabilityStatus>)[capability]
    : undefined;
  if (!status) {
    return {
      status: "unsupported",
      reason: `Capability '${capability}' is not declared for runtime '${canonical}'.`,
    };
  }
  return status;
}
