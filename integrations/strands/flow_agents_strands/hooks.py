"""
hooks.py — FlowAgentsHooks: the main HookProvider for AWS Strands Agents.

Design: duck-typed so strands-agents is NOT required at import time.
The class uses TYPE_CHECKING guards and string-based isinstance() avoidance so
the full module tree is importable and unit-testable without the SDK installed.

When strands-agents IS installed, FlowAgentsHooks is a valid HookProvider
because it implements the register_hooks(registry, **kwargs) protocol method.

Usage (with strands installed):

    from strands import Agent
    from flow_agents_strands import FlowAgentsHooks

    hooks = FlowAgentsHooks(workspace=".")
    system_prompt = "You are a helpful agent." + hooks.steering_context()
    agent = Agent(system_prompt=system_prompt, hooks=[hooks])

Usage (without strands, e.g. in tests):

    from flow_agents_strands import FlowAgentsHooks
    hooks = FlowAgentsHooks()
    ctx = hooks.steering_context()   # works without strands
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, Optional, TYPE_CHECKING

from .telemetry import TelemetrySink, STRANDS_TO_CANONICAL
from .policy import PolicyGate
from .steering import SteeringContext

if TYPE_CHECKING:
    # These imports only run during static type-checking (mypy/pyright).
    # At runtime the try/except below handles the optional SDK.
    from strands.hooks import (  # type: ignore[import]
        HookRegistry,
        BeforeInvocationEvent,
        AfterInvocationEvent,
        BeforeToolCallEvent,
        AfterToolCallEvent,
    )


class FlowAgentsHooks:
    """
    Flow Agents HookProvider for AWS Strands Agents.

    Implements the strands HookProvider protocol (register_hooks) via duck
    typing.  When strands-agents is not installed the class still fully
    constructs and is usable for telemetry emission and steering context
    loading.

    Args:
        sink_path:   Directory or file path for JSONL telemetry output.
                     Default: <workspace>/.flow-agents/.telemetry/full.jsonl
        workspace:   Root of the workspace to discover .flow-agents/ from.
                     Default: current working directory.
        agent_name:  Agent identifier embedded in telemetry events.
        runtime:     Runtime label embedded in telemetry events.
        policy_gate: Optional PolicyGate instance; defaults to PolicyGate().
    """

    def __init__(
        self,
        sink_path: Optional[str] = None,
        workspace: Optional[str] = None,
        agent_name: str = "strands-agent",
        runtime: str = "strands",
        policy_gate: Optional[PolicyGate] = None,
    ) -> None:
        self._sink = TelemetrySink(
            sink_path=sink_path,
            workspace=workspace,
            agent_name=agent_name,
            runtime=runtime,
        )
        self._policy = policy_gate if policy_gate is not None else PolicyGate()
        self._steering = SteeringContext(workspace=workspace)
        self._session_start_ts: Optional[float] = None
        # Per-model token accumulator, summed across model-call events.
        self._usage_by_model: Dict[str, Dict[str, int]] = {}

    # ------------------------------------------------------------------
    # Public API available WITHOUT strands installed
    # ------------------------------------------------------------------

    def steering_context(self) -> str:
        """
        Return workflow-steering context text for the current workspace.

        Callers should append this to the Agent's system prompt at construction
        time — e.g.:

            system_prompt = base_prompt + hooks.steering_context()

        This is the documented spike approach because Strands'
        BeforeInvocationEvent does not expose a mutable system_prompt.
        See README.md § Limitations.
        """
        text = self._steering.load()
        if text:
            self._sink.emit_steering(text)
        return text

    # ------------------------------------------------------------------
    # HookProvider protocol (register_hooks)
    # ------------------------------------------------------------------

    def register_hooks(self, registry: Any, **kwargs: Any) -> None:
        """
        Register Flow Agents callbacks with a Strands HookRegistry.

        This method is the sole method required by the HookProvider protocol.
        The registry parameter is typed as Any so the module compiles without
        strands-agents installed; at runtime the real HookRegistry is passed.
        """
        # Import lazily — only reachable when strands IS installed.
        try:
            from strands.hooks import (  # type: ignore[import]
                BeforeInvocationEvent,
                AfterInvocationEvent,
                BeforeToolCallEvent,
                AfterToolCallEvent,
                AgentInitializedEvent,
            )
        except ImportError as exc:
            raise ImportError(
                "strands-agents is required to register hooks. "
                "Install it with: pip install flow-agents-strands[strands]"
            ) from exc

        registry.add_callback(AgentInitializedEvent, self._on_agent_initialized)
        registry.add_callback(BeforeInvocationEvent, self._on_before_invocation)
        registry.add_callback(AfterInvocationEvent, self._on_after_invocation)
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)
        registry.add_callback(AfterToolCallEvent, self._on_after_tool_call)

        # Model-call event carries per-call token usage (the SDK's documented
        # usage source). Optional — registered only if the installed SDK exposes
        # it, under whichever name this SDK version uses.
        try:
            import strands.hooks as _sh  # type: ignore[import]

            model_event = (
                getattr(_sh, "AfterModelCallEvent", None)
                or getattr(_sh, "AfterModelInvocationEvent", None)
            )
            if model_event is not None:
                registry.add_callback(model_event, self._on_after_model_call)
        except ImportError:
            pass

    # ------------------------------------------------------------------
    # Private callbacks
    # ------------------------------------------------------------------

    def _on_agent_initialized(self, event: Any) -> None:
        """AgentInitializedEvent → agentSpawn / session.start"""
        self._session_start_ts = time.monotonic()
        self._usage_by_model = {}
        self._sink.emit_session_start()

    def _on_before_invocation(self, event: Any) -> None:
        """BeforeInvocationEvent → userPromptSubmit / turn.user"""
        if self._session_start_ts is None:
            self._session_start_ts = time.monotonic()
        self._sink.emit("userPromptSubmit")

    def _on_after_invocation(self, event: Any) -> None:
        """AfterInvocationEvent → emit session.usage (if any) then stop / session.end"""
        duration_s = 0.0
        if self._session_start_ts is not None:
            duration_s = time.monotonic() - self._session_start_ts

        if self._usage_by_model:
            by_model = []
            totals = {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0}
            for model, tok in self._usage_by_model.items():
                by_model.append(
                    {
                        "model": model,
                        "input_tokens": tok["input"],
                        "output_tokens": tok["output"],
                        "cache_creation_input_tokens": tok["cache_creation"],
                        "cache_read_input_tokens": tok["cache_read"],
                    }
                )
                for key in totals:
                    totals[key] += tok[key]
            self._sink.emit_usage(
                model=next(iter(self._usage_by_model)) if len(self._usage_by_model) == 1 else None,
                input_tokens=totals["input"],
                output_tokens=totals["output"],
                cache_creation_input_tokens=totals["cache_creation"],
                cache_read_input_tokens=totals["cache_read"],
                duration_s=duration_s,
                by_model=by_model,
            )
            self._usage_by_model = {}

        self._sink.emit_session_end(duration_s=duration_s)

    def _on_after_model_call(self, event: Any) -> None:
        """Model-call event → accumulate per-model token usage.

        Reads the documented Anthropic usage object (input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens) from wherever the
        Strands event surfaces it. Defensive across SDK shapes; no-op if absent.
        """
        extracted = _extract_model_usage(event)
        if extracted is None:
            return
        model = extracted["model"]
        acc = self._usage_by_model.setdefault(
            model, {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0}
        )
        acc["input"] += extracted["input"]
        acc["output"] += extracted["output"]
        acc["cache_creation"] += extracted["cache_creation"]
        acc["cache_read"] += extracted["cache_read"]

    def _on_before_tool_call(self, event: Any) -> None:
        """
        BeforeToolCallEvent → preToolUse / tool.invoke + policy gate.

        If the policy gate blocks the call, sets event.cancel_tool to the
        block reason (Strands will cancel the tool and return the message
        as the tool result).
        """
        tool_use = getattr(event, "tool_use", {}) or {}
        tool_name = tool_use.get("name", "")
        tool_input = tool_use.get("input", {}) or {}

        # Emit telemetry first (fail-open: policy check follows)
        self._sink.emit_tool_invoke(tool_name=tool_name, tool_input=tool_input)

        # Policy gate
        block_reason = self._policy.check_tool_call(
            tool_name=tool_name,
            tool_input=tool_input,
        )
        if block_reason:
            try:
                event.cancel_tool = block_reason
            except AttributeError:
                # Some event mock or future SDK change; log and continue
                pass

    def _on_after_tool_call(self, event: Any) -> None:
        """AfterToolCallEvent → postToolUse / tool.result"""
        tool_use = getattr(event, "tool_use", {}) or {}
        tool_name = tool_use.get("name", "")
        result = getattr(event, "result", None)
        self._sink.emit_tool_result(tool_name=tool_name, tool_output=result)


# ----------------------------------------------------------------------------
# Usage extraction — map a Strands model-call event onto the documented
# Anthropic usage object, defensively across SDK shapes (object or dict).
# ----------------------------------------------------------------------------


def _attr(obj: Any, *keys: str) -> Any:
    for key in keys:
        if isinstance(obj, dict):
            if key in obj and obj[key] is not None:
                return obj[key]
        else:
            value = getattr(obj, key, None)
            if value is not None:
                return value
    return None


def _num(obj: Any, *keys: str) -> int:
    value = _attr(obj, *keys)
    return value if isinstance(value, (int, float)) else 0


def _extract_model_usage(event: Any) -> Optional[Dict[str, Any]]:
    containers = [
        event,
        _attr(event, "usage"),
        _attr(event, "response"),
        _attr(event, "result"),
        _attr(event, "message"),
        _attr(event, "output"),
        _attr(event, "model_response"),
    ]
    usage = None
    model_carrier = None
    for container in containers:
        if container is None:
            continue
        candidate = _attr(container, "usage")
        if candidate is None and (_attr(container, "input_tokens", "inputTokens") is not None):
            candidate = container
        if candidate is not None and usage is None:
            usage = candidate
        if model_carrier is None and _attr(container, "model", "model_id", "modelId") is not None:
            model_carrier = container
    if usage is None:
        return None

    tokens = {
        "input": _num(usage, "input_tokens", "inputTokens"),
        "output": _num(usage, "output_tokens", "outputTokens"),
        "cache_creation": _num(usage, "cache_creation_input_tokens", "cacheCreationInputTokens"),
        "cache_read": _num(usage, "cache_read_input_tokens", "cacheReadInputTokens"),
    }
    if not any(tokens.values()):
        return None

    model = _attr(model_carrier, "model", "model_id", "modelId") or _attr(usage, "model") or "unknown"
    return {"model": str(model), **tokens}
