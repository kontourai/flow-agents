/**
 * Knowledge Kit — Telemetry Helper
 *
 * Emits canonical Flow Agents telemetry events (schema v0.3.0) to a JSONL
 * sink file. Matches the event shape produced by telemetry.sh and the Python
 * TelemetrySink in integrations/strands/flow_agents_strands/telemetry.py.
 *
 * Zero runtime dependencies beyond Node.js built-ins.
 * Fails open: telemetry errors never block kit operations.
 *
 * Sink path: <workspace>/.kontourai/telemetry/full.jsonl
 * The workspace is resolved from FLOW_AGENTS_WORKSPACE env var, falling back
 * to process.cwd().
 *
 * @module adapters/flow-runner/telemetry
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "0.3.0";

// Canonical event name → schema event_type  (mirrors telemetry.sh schema_event_type())
const CANONICAL_TO_SCHEMA = {
  agentSpawn:        "session.start",
  userPromptSubmit:  "turn.user",
  preToolUse:        "tool.invoke",
  permissionRequest: "tool.permission_request",
  postToolUse:       "tool.result",
  stop:              "session.end",
  subagentStart:     "agent.delegate",
  subagentStop:      "agent.delegate",
};

function schemaEventType(canonical) {
  return CANONICAL_TO_SCHEMA[canonical] || "unknown";
}

// ---------------------------------------------------------------------------
// Sink resolution
// ---------------------------------------------------------------------------

function resolveSinkPath(workspace) {
  const ws = workspace || process.env.FLOW_AGENTS_WORKSPACE || process.cwd();
  return path.join(ws, ".kontourai", "telemetry", "full.jsonl");
}

// ---------------------------------------------------------------------------
// KnowledgeTelemetry
// ---------------------------------------------------------------------------

/**
 * Thin telemetry sink for the Knowledge Kit flow runner.
 *
 * Usage:
 *   const tel = new KnowledgeTelemetry({ workspace: "/path/to/workspace" });
 *   tel.emitGate("knowledge.ingest", "classify-gate", { category: "research", record_id: id });
 */
export class KnowledgeTelemetry {
  /**
   * @param {{ workspace?: string, agentName?: string, sessionId?: string }} options
   */
  constructor({ workspace, agentName, sessionId } = {}) {
    this._sinkPath = resolveSinkPath(workspace);
    this._agentName = agentName || "knowledge-kit";
    this._sessionId = sessionId || crypto.randomUUID();

    // Ensure the sink directory exists; fail open on error
    try {
      fs.mkdirSync(path.dirname(this._sinkPath), { recursive: true });
    } catch {
      // fail open
    }
  }

  // -------------------------------------------------------------------------
  // Core emit
  // -------------------------------------------------------------------------

  /**
   * Build and append a canonical telemetry event to the JSONL sink.
   * Returns the emitted event object (useful for tests).
   * Fails open: never throws.
   *
   * @param {string} canonicalEvent  - canonical event name (e.g. "preToolUse")
   * @param {object} [extra]         - additional fields merged into the event
   * @returns {object} the emitted event
   */
  emit(canonicalEvent, extra) {
    const schemaType = schemaEventType(canonicalEvent);
    const event = {
      schema_version: SCHEMA_VERSION,
      timestamp: String(Date.now()),
      session_id: this._sessionId,
      event_id: crypto.randomUUID(),
      event_type: schemaType,
      agent: {
        name: this._agentName,
        runtime: "knowledge-kit",
        version: "unknown",
      },
      hook: {
        event_name: canonicalEvent,
        runtime_session_id: "",
        turn_id: "",
        transcript_path: "",
        model: "",
        source: "knowledge-kit",
        stop_hook_active: null,
        last_assistant_message: "",
        raw_input: null,
      },
    };

    if (extra && typeof extra === "object") {
      Object.assign(event, extra);
    }

    try {
      fs.appendFileSync(this._sinkPath, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // fail open — telemetry must never block kit operations
    }

    return event;
  }

  // -------------------------------------------------------------------------
  // Semantic helpers
  // -------------------------------------------------------------------------

  /**
   * Emit a gate event. Used at each flow gate point in the runner.
   *
   * @param {string} flowId    - e.g. "knowledge.ingest"
   * @param {string} gateId    - e.g. "classify-gate"
   * @param {object} [context] - gate-specific context payload
   * @returns {object} the emitted event
   */
  emitGate(flowId, gateId, context) {
    return this.emit("preToolUse", {
      tool: {
        name: `${flowId}.${gateId}`,
        normalized_name: "flow.gate",
        input: context || null,
      },
    });
  }

  /**
   * Emit a gate-result event.
   *
   * @param {string} flowId    - e.g. "knowledge.ingest"
   * @param {string} gateId    - e.g. "classify-gate"
   * @param {object} [result]  - gate result payload
   * @returns {object} the emitted event
   */
  emitGateResult(flowId, gateId, result) {
    return this.emit("postToolUse", {
      tool: {
        name: `${flowId}.${gateId}`,
        normalized_name: "flow.gate",
        output: result || null,
      },
    });
  }
}

export default KnowledgeTelemetry;
