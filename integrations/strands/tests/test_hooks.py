"""
Tests for FlowAgentsHooks — fake registry + fake event objects.

These tests exercise the full hook-wiring path without requiring
strands-agents to be installed.  A minimal fake registry / event surface
mirrors the Strands API contract described in the mission brief.
"""

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


# ---------------------------------------------------------------------------
# Fake Strands hook infrastructure (no SDK required)
# ---------------------------------------------------------------------------

class FakeHookRegistry:
    """Minimal stand-in for strands.hooks.HookRegistry."""

    def __init__(self):
        self._callbacks: Dict[str, List[Callable]] = {}

    def add_callback(self, event_cls, callback: Callable) -> None:
        # Use the class's __name__ as the dispatch key
        key = event_cls.__name__
        self._callbacks.setdefault(key, []).append(callback)

    def fire(self, event) -> None:
        key = type(event).__name__
        for cb in self._callbacks.get(key, []):
            cb(event)


# Fake event classes — named to match what register_hooks imports from strands.hooks
class AgentInitializedEvent:
    pass


class BeforeInvocationEvent:
    pass


class AfterInvocationEvent:
    pass


class BeforeToolCallEvent:
    cancel_tool: Optional[str] = None

    def __init__(self, tool_name: str, tool_input: Optional[dict] = None):
        self.tool_use = {"name": tool_name, "input": tool_input or {}}
        self.cancel_tool = None


class AfterToolCallEvent:
    def __init__(self, tool_name: str, result: Any = None):
        self.tool_use = {"name": tool_name, "input": {}}
        self.result = result
        self.retry = False


# ---------------------------------------------------------------------------
# Install fake strands module into sys.modules so FlowAgentsHooks can import
# from strands.hooks without the real SDK being installed.
# ---------------------------------------------------------------------------

def _install_fake_strands() -> None:
    """Install minimal fake strands.hooks module into sys.modules."""
    strands_mod = types.ModuleType("strands")
    hooks_mod = types.ModuleType("strands.hooks")

    # Register each class using its canonical Strands name (the class __name__)
    for cls in [
        AgentInitializedEvent,
        BeforeInvocationEvent,
        AfterInvocationEvent,
        BeforeToolCallEvent,
        AfterToolCallEvent,
    ]:
        setattr(hooks_mod, cls.__name__, cls)

    strands_mod.hooks = hooks_mod  # type: ignore[attr-defined]
    sys.modules["strands"] = strands_mod
    sys.modules["strands.hooks"] = hooks_mod


_install_fake_strands()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestFlowAgentsHooksRegistration(unittest.TestCase):
    """Verify register_hooks wires callbacks without raising."""

    def _make_hooks(self, tmp_dir: str):
        from flow_agents_strands import FlowAgentsHooks
        return FlowAgentsHooks(sink_path=tmp_dir, agent_name="test-agent")

    def test_register_hooks_runs_without_error(self):
        with tempfile.TemporaryDirectory() as d:
            hooks = self._make_hooks(d)
            registry = FakeHookRegistry()
            hooks.register_hooks(registry)
            self.assertTrue(len(registry._callbacks) > 0)

    def test_all_five_event_types_registered(self):
        with tempfile.TemporaryDirectory() as d:
            hooks = self._make_hooks(d)
            registry = FakeHookRegistry()
            hooks.register_hooks(registry)
            expected = {
                "AgentInitializedEvent",
                "BeforeInvocationEvent",
                "AfterInvocationEvent",
                "BeforeToolCallEvent",
                "AfterToolCallEvent",
            }
            self.assertEqual(expected, set(registry._callbacks.keys()))


class TestFlowAgentsHooksTelemetry(unittest.TestCase):
    """Verify telemetry events are emitted with correct shape."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _make_hooks(self):
        from flow_agents_strands import FlowAgentsHooks
        return FlowAgentsHooks(
            sink_path=str(self._tmp_path),
            agent_name="test-agent",
        )

    def _read_events(self):
        log_file = self._tmp_path / "full.jsonl"
        if not log_file.exists():
            return []
        return [
            json.loads(line)
            for line in log_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_session_start_emitted_on_agent_initialized(self):
        hooks = self._make_hooks()
        hooks._on_agent_initialized(AgentInitializedEvent())
        events = self._read_events()
        self.assertEqual(1, len(events))
        self.assertEqual("session.start", events[0]["event_type"])

    def test_tool_invoke_emitted_on_before_tool_call(self):
        hooks = self._make_hooks()
        event = BeforeToolCallEvent("read", {"path": "README.md"})
        hooks._on_before_tool_call(event)
        events = self._read_events()
        self.assertEqual(1, len(events))
        self.assertEqual("tool.invoke", events[0]["event_type"])
        self.assertEqual("read", events[0]["tool"]["name"])

    def test_tool_result_emitted_on_after_tool_call(self):
        hooks = self._make_hooks()
        event = AfterToolCallEvent("read", result="file content")
        hooks._on_after_tool_call(event)
        events = self._read_events()
        self.assertEqual(1, len(events))
        self.assertEqual("tool.result", events[0]["event_type"])
        self.assertEqual("file content", events[0]["tool"]["output"])

    def test_session_end_emitted_on_after_invocation(self):
        hooks = self._make_hooks()
        hooks._on_agent_initialized(AgentInitializedEvent())
        hooks._on_after_invocation(AfterInvocationEvent())
        events = self._read_events()
        types_ = [e["event_type"] for e in events]
        self.assertIn("session.end", types_)

    def test_full_lifecycle_produces_correct_sequence(self):
        hooks = self._make_hooks()
        hooks._on_agent_initialized(AgentInitializedEvent())
        hooks._on_before_invocation(BeforeInvocationEvent())
        hooks._on_before_tool_call(BeforeToolCallEvent("bash", {"command": "ls"}))
        hooks._on_after_tool_call(AfterToolCallEvent("bash", result="file1.py"))
        hooks._on_after_invocation(AfterInvocationEvent())

        events = self._read_events()
        types_ = [e["event_type"] for e in events]
        self.assertEqual(
            ["session.start", "turn.user", "tool.invoke", "tool.result", "session.end"],
            types_,
        )


class TestFlowAgentsHooksPolicyGate(unittest.TestCase):
    """
    Verify tool-call cancellation on protected-config writes.

    This is the key spike proof-point: a BeforeToolCallEvent targeting a
    protected config file must result in event.cancel_tool being set.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def _make_hooks(self):
        from flow_agents_strands import FlowAgentsHooks
        return FlowAgentsHooks(sink_path=self._tmp.name, agent_name="test")

    def test_cancel_tool_set_for_protected_write(self):
        hooks = self._make_hooks()
        event = BeforeToolCallEvent("write", {"path": ".eslintrc.json"})
        hooks._on_before_tool_call(event)
        self.assertIsNotNone(event.cancel_tool)
        self.assertIn("BLOCKED", event.cancel_tool)

    def test_cancel_tool_not_set_for_safe_write(self):
        hooks = self._make_hooks()
        event = BeforeToolCallEvent("write", {"path": "src/main.py"})
        hooks._on_before_tool_call(event)
        self.assertIsNone(event.cancel_tool)

    def test_cancel_tool_not_set_for_read_on_protected_file(self):
        hooks = self._make_hooks()
        event = BeforeToolCallEvent("read", {"path": ".eslintrc.json"})
        hooks._on_before_tool_call(event)
        self.assertIsNone(event.cancel_tool)

    def test_cancel_tool_covers_all_protected_files(self):
        from flow_agents_strands.policy import PROTECTED_FILES
        hooks = self._make_hooks()
        for fname in PROTECTED_FILES:
            with self.subTest(file=fname):
                event = BeforeToolCallEvent("write", {"path": f"/repo/{fname}"})
                hooks._on_before_tool_call(event)
                self.assertIsNotNone(
                    event.cancel_tool,
                    f"Expected cancel_tool for {fname} but got None",
                )

    def test_telemetry_still_emitted_even_when_cancelled(self):
        """Policy block must not suppress telemetry."""
        hooks = self._make_hooks()
        event = BeforeToolCallEvent("write", {"path": "biome.json"})
        hooks._on_before_tool_call(event)
        log_file = Path(self._tmp.name) / "full.jsonl"
        lines = log_file.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(1, len(lines))
        parsed = json.loads(lines[0])
        self.assertEqual("tool.invoke", parsed["event_type"])


class TestFlowAgentsHooksSteeringContext(unittest.TestCase):
    """Verify steering context loads without error in an empty workspace."""

    def test_steering_context_returns_string(self):
        with tempfile.TemporaryDirectory() as d:
            from flow_agents_strands import FlowAgentsHooks
            hooks = FlowAgentsHooks(sink_path=d, workspace=d)
            ctx = hooks.steering_context()
            self.assertIsInstance(ctx, str)

    def test_steering_context_empty_when_no_flow_agents_dir(self):
        with tempfile.TemporaryDirectory() as d:
            from flow_agents_strands import FlowAgentsHooks
            hooks = FlowAgentsHooks(sink_path=d, workspace=d)
            ctx = hooks.steering_context()
            self.assertEqual("", ctx)

    def test_steering_context_with_active_state(self):
        """If .flow-agents/task/state.json has active status, context is returned."""
        with tempfile.TemporaryDirectory() as d:
            state_dir = Path(d) / ".flow-agents" / "my-task"
            state_dir.mkdir(parents=True)
            state = {
                "task_slug": "my-task",
                "status": "in_progress",
                "phase": "execute",
                "next_action": {"summary": "Run tests", "target_phase": "verify"},
            }
            (state_dir / "state.json").write_text(
                json.dumps(state), encoding="utf-8"
            )
            from flow_agents_strands import FlowAgentsHooks
            hooks = FlowAgentsHooks(sink_path=d, workspace=d)
            ctx = hooks.steering_context()
            self.assertIn("my-task", ctx)
            self.assertIn("in_progress", ctx)


if __name__ == "__main__":
    unittest.main()

class TestSteeringContextKitFlows(unittest.TestCase):
    """
    Verify steering context surfaces activated kit flows from the strands-local
    runtime path — Issue #32 AC2.

    Fixture: a fake .flow.json file written to the path that activateStrandsLocal
    produces (.flow-agents/runtime/strands/flows/<kit-id>/<asset-id>.flow.json).
    """

    def _write_fake_flow(self, workspace: Path, kit_id: str, asset_id: str, description: str = "") -> None:
        flows_dir = workspace / ".flow-agents" / "runtime" / "strands" / "flows" / kit_id
        flows_dir.mkdir(parents=True, exist_ok=True)
        flow_file = flows_dir / f"{asset_id.replace('.', '-')}.flow.json"
        payload = {"id": asset_id, "description": description}
        flow_file.write_text(json.dumps(payload), encoding="utf-8")

    def test_kit_flows_empty_when_no_runtime_dir(self):
        """No runtime dir → no kit flows hint in steering context."""
        from flow_agents_strands.steering import SteeringContext
        with tempfile.TemporaryDirectory() as d:
            ctx = SteeringContext(workspace=d)
            result = ctx.load()
            self.assertNotIn("KIT FLOWS", result)

    def test_kit_flows_surfaced_when_runtime_flow_files_exist(self):
        """Fake runtime flow file → kit flow id appears in steering context (AC2)."""
        from flow_agents_strands.steering import SteeringContext
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            self._write_fake_flow(ws, "builder", "builder.shape", "Shape a problem.")
            ctx = SteeringContext(workspace=d)
            result = ctx.load()
            self.assertIn("KIT FLOWS", result)
            self.assertIn("builder.shape", result)

    def test_kit_flows_includes_description(self):
        """Description from flow JSON appears in steering context."""
        from flow_agents_strands.steering import SteeringContext
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            self._write_fake_flow(ws, "builder", "builder.build", "Build a feature end-to-end.")
            ctx = SteeringContext(workspace=d)
            result = ctx.load()
            self.assertIn("Build a feature end-to-end.", result)

    def test_kit_flows_multiple_flows_all_listed(self):
        """Multiple kit flows all appear in steering context."""
        from flow_agents_strands.steering import SteeringContext
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            self._write_fake_flow(ws, "builder", "builder.shape", "Shape.")
            self._write_fake_flow(ws, "builder", "builder.build", "Build.")
            ctx = SteeringContext(workspace=d)
            result = ctx.load()
            self.assertIn("builder.shape", result)
            self.assertIn("builder.build", result)

    def test_kit_flows_malformed_json_skipped(self):
        """Malformed flow JSON does not crash steering; other flows still appear."""
        from flow_agents_strands.steering import SteeringContext
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            self._write_fake_flow(ws, "builder", "builder.shape", "Shape.")
            # Write a malformed flow file
            bad_dir = ws / ".flow-agents" / "runtime" / "strands" / "flows" / "builder"
            bad_dir.mkdir(parents=True, exist_ok=True)
            (bad_dir / "bad.flow.json").write_text("{ not valid json", encoding="utf-8")
            ctx = SteeringContext(workspace=d)
            result = ctx.load()
            # builder.shape should still appear; no crash
            self.assertIn("builder.shape", result)

    def test_hooks_steering_context_surfaces_kit_flows(self):
        """FlowAgentsHooks.steering_context() surfaces kit flows (AC2 via hooks layer)."""
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            flows_dir = ws / ".flow-agents" / "runtime" / "strands" / "flows" / "builder"
            flows_dir.mkdir(parents=True)
            (flows_dir / "builder-shape.flow.json").write_text(
                json.dumps({"id": "builder.shape", "description": "Shape a problem."}),
                encoding="utf-8",
            )
            from flow_agents_strands import FlowAgentsHooks
            hooks = FlowAgentsHooks(sink_path=d, workspace=d)
            ctx = hooks.steering_context()
            self.assertIn("KIT FLOWS", ctx)
            self.assertIn("builder.shape", ctx)
