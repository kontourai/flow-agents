"""
Tests for telemetry module — event mapping and JSONL emission shape.

Uses stdlib unittest only; no strands-agents required.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path


class TestStrandsToCanonicalMapping(unittest.TestCase):
    """Verify the Strands → canonical event-name mapping table."""

    def setUp(self):
        from flow_agents_strands.telemetry import STRANDS_TO_CANONICAL
        self.mapping = STRANDS_TO_CANONICAL

    def test_all_expected_keys_present(self):
        expected = {
            "AgentInitializedEvent",
            "BeforeInvocationEvent",
            "AfterInvocationEvent",
            "BeforeToolCallEvent",
            "AfterToolCallEvent",
            "AfterModelCallEvent",
            "MessageAddedEvent",
        }
        self.assertEqual(expected, set(self.mapping.keys()))

    def test_before_invocation_maps_to_user_prompt_submit(self):
        self.assertEqual("userPromptSubmit", self.mapping["BeforeInvocationEvent"])

    def test_after_invocation_maps_to_stop(self):
        self.assertEqual("stop", self.mapping["AfterInvocationEvent"])

    def test_before_tool_call_maps_to_pre_tool_use(self):
        self.assertEqual("preToolUse", self.mapping["BeforeToolCallEvent"])

    def test_after_tool_call_maps_to_post_tool_use(self):
        self.assertEqual("postToolUse", self.mapping["AfterToolCallEvent"])

    def test_agent_initialized_maps_to_agent_spawn(self):
        self.assertEqual("agentSpawn", self.mapping["AgentInitializedEvent"])

    def test_all_values_are_strings(self):
        for k, v in self.mapping.items():
            with self.subTest(key=k):
                self.assertIsInstance(v, str)


class TestTelemetrySinkEmission(unittest.TestCase):
    """Verify JSONL emission shape matches the canonical Flow Agents schema."""

    def setUp(self):
        from flow_agents_strands.telemetry import TelemetrySink
        self._tmp = tempfile.TemporaryDirectory()
        self._sink_dir = Path(self._tmp.name)
        self._sink = TelemetrySink(
            sink_path=str(self._sink_dir),
            agent_name="test-agent",
            runtime="strands-test",
        )

    def tearDown(self):
        self._tmp.cleanup()

    def _read_events(self):
        log_file = self._sink_dir / "full.jsonl"
        if not log_file.exists():
            return []
        lines = log_file.read_text(encoding="utf-8").strip().splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def test_session_start_event_shape(self):
        evt = self._sink.emit_session_start()

        # Top-level required fields (mirrors build_base_event in telemetry.sh)
        self.assertEqual("0.3.0", evt["schema_version"])
        self.assertIn("timestamp", evt)
        self.assertIn("session_id", evt)
        self.assertIn("event_id", evt)
        self.assertEqual("session.start", evt["event_type"])

        # Agent sub-object
        agent = evt["agent"]
        self.assertEqual("test-agent", agent["name"])
        self.assertEqual("strands-test", agent["runtime"])

    def test_session_start_written_to_jsonl(self):
        self._sink.emit_session_start()
        events = self._read_events()
        self.assertEqual(1, len(events))
        self.assertEqual("session.start", events[0]["event_type"])

    def test_tool_invoke_event_shape(self):
        evt = self._sink.emit_tool_invoke("edit", {"path": "foo.py"})
        self.assertEqual("tool.invoke", evt["event_type"])
        self.assertEqual("edit", evt["tool"]["name"])
        self.assertEqual("fs_write", evt["tool"]["normalized_name"])
        self.assertEqual({"path": "foo.py"}, evt["tool"]["input"])

    def test_tool_result_event_shape(self):
        evt = self._sink.emit_tool_result("read", "file contents")
        self.assertEqual("tool.result", evt["event_type"])
        self.assertEqual("read", evt["tool"]["name"])
        self.assertEqual("fs_read", evt["tool"]["normalized_name"])
        self.assertEqual("file contents", evt["tool"]["output"])

    def test_session_end_event_shape(self):
        evt = self._sink.emit_session_end(duration_s=42.5)
        self.assertEqual("session.end", evt["event_type"])
        self.assertAlmostEqual(42.5, evt["session"]["duration_s"])

    def test_user_prompt_submit_event_shape(self):
        evt = self._sink.emit("userPromptSubmit")
        self.assertEqual("turn.user", evt["event_type"])

    def test_hook_context_present(self):
        """Every event must include a hook sub-object (mirrors add_hook_context)."""
        evt = self._sink.emit_session_start()
        self.assertIn("hook", evt)
        hook = evt["hook"]
        self.assertIn("event_name", hook)
        self.assertIn("source", hook)
        self.assertEqual("strands", hook["source"])

    def test_multiple_events_same_session_id(self):
        self._sink.emit_session_start()
        self._sink.emit_tool_invoke("read", {})
        self._sink.emit_session_end()
        events = self._read_events()
        session_ids = {e["session_id"] for e in events}
        self.assertEqual(1, len(session_ids), "All events must share one session_id")

    def test_jsonl_each_line_valid_json(self):
        self._sink.emit_session_start()
        self._sink.emit_tool_invoke("bash", {"command": "ls"})
        self._sink.emit_session_end(duration_s=1.0)
        log_file = self._sink_dir / "full.jsonl"
        for line in log_file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                parsed = json.loads(line)   # will raise on invalid JSON
                self.assertIsInstance(parsed, dict)

    def test_sink_path_directory_creates_full_jsonl(self):
        """When sink_path is a directory, file is named full.jsonl."""
        from flow_agents_strands.telemetry import TelemetrySink
        with tempfile.TemporaryDirectory() as d:
            sink = TelemetrySink(sink_path=d)
            sink.emit_session_start()
            log_file = Path(d) / "full.jsonl"
            self.assertTrue(log_file.exists())

    def test_emit_steering_event_type(self):
        evt = self._sink.emit_steering("STATE: task is status:in_progress")
        self.assertEqual("turn.user", evt["event_type"])
        self.assertIn("steering_context", evt["turn"])


class TestNormalizeToolName(unittest.TestCase):
    """Spot-check normalize_tool_name mirrors telemetry.sh."""

    def setUp(self):
        from flow_agents_strands.telemetry import _normalize_tool_name
        self._fn = _normalize_tool_name

    def test_bash(self):
        self.assertEqual("execute_bash", self._fn("bash"))

    def test_edit_is_fs_write(self):
        self.assertEqual("fs_write", self._fn("edit"))

    def test_read_is_fs_read(self):
        self.assertEqual("fs_read", self._fn("read"))

    def test_unknown_passthrough(self):
        self.assertEqual("my_custom_tool", self._fn("my_custom_tool"))


if __name__ == "__main__":
    unittest.main()
