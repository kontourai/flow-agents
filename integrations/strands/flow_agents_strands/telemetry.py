"""
telemetry.py — Canonical Flow Agents telemetry event builder and JSONL sink.

Event taxonomy mirrors the JS telemetry hooks exactly:

  claude-telemetry-hook.js  →  canonicalEvent() mapping:
    SessionStart            → agentSpawn
    UserPromptSubmit        → userPromptSubmit
    PreToolUse              → preToolUse
    PostToolUse             → postToolUse
    PostToolUseFailure      → postToolUse
    Stop / SessionEnd       → stop
    SubagentStart           → subagentStart
    SubagentStop            → subagentStop

  telemetry.sh  →  schema_event_type():
    agentSpawn / SessionStart           → session.start
    stop / Stop / SessionEnd            → session.end
    userPromptSubmit / UserPromptSubmit → turn.user
    preToolUse / PreToolUse             → tool.invoke
    postToolUse / PostToolUse           → tool.result

Strands hook events are mapped to the same canonical names so the emitted
JSONL records are structurally identical to those produced by the Claude Code
and Codex telemetry hooks.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# Strands → canonical event-name mapping
# (module-level dict so it is inspectable / documented)
# ---------------------------------------------------------------------------

STRANDS_TO_CANONICAL: Dict[str, str] = {
    # Strands event class name  →  canonical Flow Agents event name
    "AgentInitializedEvent":  "agentSpawn",
    "BeforeInvocationEvent":  "userPromptSubmit",
    "AfterInvocationEvent":   "stop",
    "BeforeToolCallEvent":    "preToolUse",
    "AfterToolCallEvent":     "postToolUse",
    "AfterModelCallEvent":    "postToolUse",   # closest analogue; no tool name
    "MessageAddedEvent":      "userPromptSubmit",
}

# Canonical → schema event type  (mirrors telemetry.sh schema_event_type())
_CANONICAL_TO_SCHEMA: Dict[str, str] = {
    "agentSpawn":        "session.start",
    "userPromptSubmit":  "turn.user",
    "preToolUse":        "tool.invoke",
    "permissionRequest": "tool.permission_request",
    "postToolUse":       "tool.result",
    "stop":              "session.end",
    "subagentStart":     "agent.delegate",
    "subagentStop":      "agent.delegate",
}


def _schema_event_type(canonical: str) -> str:
    return _CANONICAL_TO_SCHEMA.get(canonical, "unknown")


# ---------------------------------------------------------------------------
# JSONL sink
# ---------------------------------------------------------------------------

class TelemetrySink:
    """
    Writes canonical Flow Agents telemetry events to a JSONL file.

    Default path: <workspace>/.flow-agents/.telemetry/full.jsonl
    This matches the local-files sink convention from config.sh:
      TELEMETRY_CHANNEL_FULL_LOG_FILE = <data_dir>/full.jsonl
      where data_dir defaults to <repo_root>/.telemetry/

    For the Strands adapter we follow the harness convention of writing
    inside .flow-agents/.telemetry/ to keep everything under one dot-dir.
    """

    DEFAULT_SUBDIR = Path(".flow-agents") / ".telemetry"
    DEFAULT_FILENAME = "full.jsonl"
    SCHEMA_VERSION = "0.3.0"

    def __init__(
        self,
        sink_path: Optional[str] = None,
        workspace: Optional[str] = None,
        agent_name: str = "strands-agent",
        runtime: str = "strands",
    ) -> None:
        self.agent_name = agent_name
        self.runtime = runtime
        self._session_id: Optional[str] = None

        ws = Path(workspace) if workspace else Path.cwd()
        if sink_path:
            p = Path(sink_path)
            # If given a directory, append default filename
            if p.suffix == "":
                self._log_file = p / self.DEFAULT_FILENAME
            else:
                self._log_file = p
        else:
            self._log_file = ws / self.DEFAULT_SUBDIR / self.DEFAULT_FILENAME

        self._log_file.parent.mkdir(parents=True, exist_ok=True)

    @property
    def session_id(self) -> str:
        if self._session_id is None:
            self._session_id = str(uuid.uuid4())
        return self._session_id

    def _base_event(self, schema_event_type: str) -> Dict[str, Any]:
        """Build the base event envelope matching telemetry.sh build_base_event()."""
        return {
            "schema_version": self.SCHEMA_VERSION,
            "timestamp": str(int(time.time() * 1000)),
            "session_id": self.session_id,
            "event_id": str(uuid.uuid4()),
            "event_type": schema_event_type,
            "agent": {
                "name": self.agent_name,
                "runtime": self.runtime,
                "version": "unknown",
            },
        }

    def emit(
        self,
        canonical_event: str,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Build and write a canonical telemetry event.

        Returns the emitted dict (useful for tests / callers that need the
        event for further processing).
        """
        schema_type = _schema_event_type(canonical_event)
        event = self._base_event(schema_type)

        # Attach hook context stub (mirrors add_hook_context() in telemetry.sh)
        event["hook"] = {
            "event_name": canonical_event,
            "runtime_session_id": "",
            "turn_id": "",
            "transcript_path": "",
            "model": "",
            "source": "strands",
            "stop_hook_active": None,
            "last_assistant_message": "",
            "raw_input": None,
        }

        if extra:
            event.update(extra)

        try:
            with self._log_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(event) + "\n")
        except OSError:
            pass  # fail-open: telemetry must never block agent work

        return event

    def emit_session_start(self, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.emit("agentSpawn", extra)

    def emit_session_end(self, duration_s: float = 0.0) -> Dict[str, Any]:
        return self.emit("stop", {"session": {"duration_s": duration_s}})

    def emit_tool_invoke(
        self,
        tool_name: str,
        tool_input: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self.emit(
            "preToolUse",
            {
                "tool": {
                    "name": tool_name,
                    "normalized_name": _normalize_tool_name(tool_name),
                    "input": tool_input,
                }
            },
        )

    def emit_tool_result(
        self,
        tool_name: str,
        tool_output: Any = None,
    ) -> Dict[str, Any]:
        return self.emit(
            "postToolUse",
            {
                "tool": {
                    "name": tool_name,
                    "normalized_name": _normalize_tool_name(tool_name),
                    "output": tool_output,
                }
            },
        )

    def emit_steering(self, steering_text: str) -> Dict[str, Any]:
        """Emit a synthetic userPromptSubmit event carrying steering context."""
        return self.emit(
            "userPromptSubmit",
            {"turn": {"prompt_text": "", "steering_context": steering_text}},
        )

    def emit_usage(
        self,
        *,
        model: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
        cache_read_input_tokens: int = 0,
        duration_s: Optional[float] = None,
        by_model: Optional[list] = None,
    ) -> Dict[str, Any]:
        """
        Emit a ``session.usage`` event with real token counts + derived cost.

        The Strands SDK surfaces per-invocation usage on model-call events;
        accumulate those and pass the totals here at session end. Tokens are the
        source of truth; ``estimated_cost_usd`` is derived from PRICING (the
        console recomputes it authoritatively, so a pricing change is
        retroactive). Mirrors the ``session.usage`` shape emitted by
        scripts/telemetry/telemetry.sh so the console aggregates both the same.
        """
        event = self._base_event("session.usage")
        event["event_id"] = f"{event['event_id']}-usage"
        event["hook"] = {
            "event_name": "usage",
            "runtime_session_id": "",
            "turn_id": "",
            "transcript_path": "",
            "model": model or "",
            "source": "strands",
            "stop_hook_active": None,
            "last_assistant_message": "",
            "raw_input": None,
        }

        by_model_out = []
        for entry in by_model or []:
            tokens = _normalize_tokens(entry)
            em = entry.get("model", "unknown")
            by_model_out.append(
                {
                    "model": em,
                    "input_tokens": tokens["input"],
                    "output_tokens": tokens["output"],
                    "cache_creation_input_tokens": tokens["cache_creation"],
                    "cache_read_input_tokens": tokens["cache_read"],
                    "estimated_cost_usd": _cost_for_model(em, tokens),
                }
            )

        flat = _normalize_tokens(
            {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": cache_creation_input_tokens,
                "cache_read_input_tokens": cache_read_input_tokens,
            }
        )
        cost = (
            round(sum(m["estimated_cost_usd"] for m in by_model_out), 6)
            if by_model_out
            else _cost_for_model(model, flat)
        )

        event["usage"] = {
            "model": model or self.runtime,
            "duration_s": duration_s,
            "input_tokens": flat["input"],
            "output_tokens": flat["output"],
            "cache_creation_input_tokens": flat["cache_creation"],
            "cache_read_input_tokens": flat["cache_read"],
            "estimated_cost_usd": cost,
            "pricing_version": _pricing_version(),
            "by_model": by_model_out or None,
        }

        try:
            with self._log_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(event) + "\n")
        except OSError:
            pass  # fail-open: telemetry must never block agent work

        return event


def _normalize_tool_name(name: str) -> str:
    """
    Mirror telemetry.sh normalize_tool_name() for the most common cases.
    """
    _MAP = {
        "bash": "execute_bash",
        "execute_bash": "execute_bash",
        "shell": "execute_bash",
        "edit": "fs_write",
        "write": "fs_write",
        "fs_write": "fs_write",
        "apply_patch": "fs_write",
        "read": "fs_read",
        "fs_read": "fs_read",
        "task": "use_subagent",
        "agent": "use_subagent",
        "use_subagent": "use_subagent",
    }
    return _MAP.get(name.lower(), name)


# ---------------------------------------------------------------------------
# Usage / cost — mirror of scripts/telemetry/pricing.json (per 1M tokens, USD)
# ---------------------------------------------------------------------------

# Pricing is read from the single-source registry (scripts/telemetry/pricing.json),
# never hand-maintained here. Resolution: TELEMETRY_PRICING_FILE /
# FLOW_AGENTS_PRICING_FILE env path, else the repo-relative registry, else a
# minimal fallback. Tokens are exact regardless; the console recomputes cost
# authoritatively, so a missing file only degrades the sink's stamped estimate.
_FALLBACK_REGISTRY = {
    "current_version": "fallback",
    "versions": {
        "fallback": {
            "cache_multipliers": {"write_5m": 1.25, "write_1h": 2.0, "read": 0.1},
            "models": {},
            "default": {"input": 5.0, "output": 25.0},
            "zero_cost_models": ["<synthetic>", "synthetic", "unknown", ""],
        }
    },
}
_REGISTRY_CACHE: Optional[Dict[str, Any]] = None


def _load_registry() -> Dict[str, Any]:
    global _REGISTRY_CACHE
    if _REGISTRY_CACHE is not None:
        return _REGISTRY_CACHE
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.environ.get("TELEMETRY_PRICING_FILE"),
        os.environ.get("FLOW_AGENTS_PRICING_FILE"),
        os.path.join(here, "..", "..", "..", "scripts", "telemetry", "pricing.json"),
        os.path.join(here, "..", "..", "..", "..", "scripts", "telemetry", "pricing.json"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            with open(candidate, "r", encoding="utf-8") as fh:
                parsed = json.load(fh)
            if isinstance(parsed, dict) and isinstance(parsed.get("versions"), dict):
                _REGISTRY_CACHE = parsed
                return _REGISTRY_CACHE
        except (OSError, ValueError):
            continue
    _REGISTRY_CACHE = _FALLBACK_REGISTRY
    return _REGISTRY_CACHE


def _pricing_version() -> str:
    return str(_load_registry().get("current_version", "fallback"))


def _version_block() -> Dict[str, Any]:
    reg = _load_registry()
    versions = reg.get("versions", {})
    return versions.get(reg.get("current_version"), _FALLBACK_REGISTRY["versions"]["fallback"])


def _num(value: Any) -> int:
    return value if isinstance(value, (int, float)) else 0


def _normalize_tokens(entry: Dict[str, Any]) -> Dict[str, int]:
    return {
        "input": _num(entry.get("input_tokens")),
        "output": _num(entry.get("output_tokens")),
        "cache_creation": _num(entry.get("cache_creation_input_tokens")),
        "cache_read": _num(entry.get("cache_read_input_tokens")),
    }


def _cost_for_model(model: Optional[str], tokens: Dict[str, int]) -> float:
    block = _version_block()
    key = (model or "").strip()
    if key in set(block.get("zero_cost_models", [])):
        return 0.0
    rate = block.get("models", {}).get(key, block.get("default", {"input": 5.0, "output": 25.0}))
    cm = block.get("cache_multipliers", {"write_5m": 1.25, "read": 0.1})
    cost = (
        tokens["input"] * rate["input"]
        + tokens["output"] * rate["output"]
        + tokens["cache_creation"] * rate["input"] * cm["write_5m"]
        + tokens["cache_read"] * rate["input"] * cm["read"]
    ) / 1_000_000
    return round(cost, 6)
