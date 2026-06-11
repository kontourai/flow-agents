"""
Tests for policy module — config-protection gate.

Uses stdlib unittest only; no strands-agents required.
"""

import unittest


class TestPolicyGateConfigProtection(unittest.TestCase):

    def setUp(self):
        from flow_agents_strands.policy import PolicyGate
        self._gate = PolicyGate()

    # --- Blocked write tools ---

    def test_blocks_write_to_eslintrc(self):
        reason = self._gate.check_tool_call("write", {"path": "/repo/.eslintrc.json"})
        self.assertIsNotNone(reason)
        self.assertIn("BLOCKED", reason)
        self.assertIn(".eslintrc.json", reason)

    def test_blocks_edit_to_prettier_config(self):
        reason = self._gate.check_tool_call("edit", {"path": "prettier.config.js"})
        self.assertIsNotNone(reason)
        self.assertIn("BLOCKED", reason)

    def test_blocks_fs_write_to_biome_json(self):
        reason = self._gate.check_tool_call("fs_write", {"file_path": "biome.json"})
        self.assertIsNotNone(reason)

    def test_blocks_edit_to_ruff_toml(self):
        reason = self._gate.check_tool_call("edit", {"path": "ruff.toml"})
        self.assertIsNotNone(reason)

    def test_blocks_apply_patch_to_markdownlint(self):
        reason = self._gate.check_tool_call(
            "apply_patch", {"path": ".markdownlint.json"}
        )
        self.assertIsNotNone(reason)

    def test_block_message_includes_guidance(self):
        reason = self._gate.check_tool_call("write", {"path": ".eslintrc"})
        self.assertIn("linter/formatter rules", reason)

    # --- Allowed cases ---

    def test_allows_write_to_regular_python_file(self):
        reason = self._gate.check_tool_call("write", {"path": "src/main.py"})
        self.assertIsNone(reason)

    def test_allows_read_on_protected_file(self):
        """Read tools must never be blocked."""
        reason = self._gate.check_tool_call("read", {"path": ".eslintrc.json"})
        self.assertIsNone(reason)

    def test_allows_bash(self):
        reason = self._gate.check_tool_call("bash", {"command": "ls"})
        self.assertIsNone(reason)

    def test_allows_write_without_path(self):
        """No path → no block."""
        reason = self._gate.check_tool_call("write", {})
        self.assertIsNone(reason)

    def test_allows_write_to_package_json(self):
        reason = self._gate.check_tool_call("write", {"path": "package.json"})
        self.assertIsNone(reason)

    # --- Full protected-files coverage ---

    def test_all_canonical_protected_files_are_blocked(self):
        from flow_agents_strands.policy import PROTECTED_FILES
        for fname in PROTECTED_FILES:
            with self.subTest(file=fname):
                reason = self._gate.check_tool_call("write", {"path": f"/repo/{fname}"})
                self.assertIsNotNone(
                    reason,
                    f"Expected {fname} to be blocked but got None",
                )


class TestPolicyGateCustomProtectedFiles(unittest.TestCase):
    """Verify callers can override the protected-files set."""

    def test_custom_protected_set(self):
        from flow_agents_strands.policy import PolicyGate
        gate = PolicyGate(protected_files=frozenset(["pyproject.toml"]))
        self.assertIsNotNone(gate.check_tool_call("write", {"path": "pyproject.toml"}))
        # Default protected files should NOT be blocked with the custom set
        self.assertIsNone(gate.check_tool_call("write", {"path": ".eslintrc.json"}))


if __name__ == "__main__":
    unittest.main()


# ============================================================================
# Contract-binding tests — verify subprocess delegation to the Node.js engine
# ============================================================================


class _FakeNodeProcess:
    """
    Fake subprocess.run result for testing the engine binding path.
    """

    def __init__(self, returncode: int, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class TestPolicyGateEngineBinding(unittest.TestCase):
    """
    Verify that PolicyGate delegates to the engine subprocess contract.

    These tests inject a fake node path and engine path to exercise the
    subprocess-binding code path without requiring a live Node.js process.
    """

    def _make_gate_with_fake_engine(self, fake_returncode, fake_stderr="", fake_stdout=""):
        """
        Return a PolicyGate wired to a fake engine via monkeypatching.

        We pass _node_bin='node' and _run_hook_path='/fake/run-hook.js' so
        _engine_available is True, then patch _invoke_engine at the module level.
        """
        import unittest.mock as mock
        from flow_agents_strands import policy as policy_module

        gate = policy_module.PolicyGate(
            _node_bin="node",
            _run_hook_path="/fake/run-hook.js",
        )

        fake_result = (fake_returncode, fake_stdout, fake_stderr)
        self._patcher = mock.patch.object(
            policy_module, "_invoke_engine", return_value=fake_result
        )
        self._mock_invoke = self._patcher.start()
        return gate

    def tearDown(self):
        if hasattr(self, "_patcher"):
            self._patcher.stop()

    def test_engine_block_returns_stderr_reason(self):
        """When engine exits 2, the block reason is taken from stderr."""
        gate = self._make_gate_with_fake_engine(
            fake_returncode=2,
            fake_stderr="BLOCKED: Modifying .eslintrc.json is not allowed. Fix the source code."
        )
        reason = gate.check_tool_call("write", {"path": ".eslintrc.json"})
        self.assertIsNotNone(reason)
        self.assertIn("BLOCKED", reason)
        self.assertIn(".eslintrc.json", reason)

    def test_engine_allow_returns_none(self):
        """When engine exits 0, check_tool_call returns None (allowed)."""
        gate = self._make_gate_with_fake_engine(fake_returncode=0)
        result = gate.check_tool_call("write", {"path": "src/main.ts"})
        self.assertIsNone(result)

    def test_engine_error_fails_open(self):
        """When engine exits non-0 non-2, check_tool_call fails open (returns None)."""
        gate = self._make_gate_with_fake_engine(fake_returncode=1, fake_stderr="some error")
        result = gate.check_tool_call("write", {"path": ".eslintrc.json"})
        self.assertIsNone(result)

    def test_engine_invoked_with_correct_payload_shape(self):
        """Verify the payload sent to the engine has the expected structure."""
        import unittest.mock as mock
        from flow_agents_strands import policy as policy_module

        gate = policy_module.PolicyGate(
            _node_bin="node",
            _run_hook_path="/fake/run-hook.js",
        )

        with mock.patch.object(policy_module, "_invoke_engine", return_value=(0, "", "")) as m:
            gate.check_tool_call("write", {"path": "src/main.ts"})
            m.assert_called_once()
            call_kwargs = m.call_args
            # payload is passed as positional; check via args
            payload = call_kwargs[1]["payload"] if "payload" in call_kwargs[1] else call_kwargs[0][2]
            self.assertEqual("PreToolUse", payload.get("hook_event_name"))
            self.assertEqual("write", payload.get("tool_name"))
            self.assertEqual({"path": "src/main.ts"}, payload.get("tool_input"))

    def test_read_tool_skips_engine(self):
        """Read tools must bypass the engine entirely (tool-name pre-filter)."""
        import unittest.mock as mock
        from flow_agents_strands import policy as policy_module

        gate = policy_module.PolicyGate(
            _node_bin="node",
            _run_hook_path="/fake/run-hook.js",
        )

        with mock.patch.object(policy_module, "_invoke_engine", return_value=(2, "", "BLOCKED")) as m:
            result = gate.check_tool_call("read", {"path": ".eslintrc.json"})
            self.assertIsNone(result)
            m.assert_not_called()

    def test_custom_protected_set_bypasses_engine(self):
        """Custom protected_files use Python evaluation, not the engine subprocess."""
        import unittest.mock as mock
        from flow_agents_strands import policy as policy_module

        gate = policy_module.PolicyGate(
            protected_files=frozenset(["pyproject.toml"]),
            _node_bin="node",
            _run_hook_path="/fake/run-hook.js",
        )

        with mock.patch.object(policy_module, "_invoke_engine") as m:
            result = gate.check_tool_call("write", {"path": "pyproject.toml"})
            self.assertIsNotNone(result)  # blocked by custom set
            m.assert_not_called()  # engine not called

    def test_no_engine_path_falls_back_to_python(self):
        """When run-hook.js is not found, PolicyGate falls back to Python evaluation."""
        import warnings
        from flow_agents_strands import policy as policy_module

        # Passing None explicitly overrides module-level resolution, forcing fallback
        gate = policy_module.PolicyGate(_node_bin="node", _run_hook_path=None)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = gate.check_tool_call("write", {"path": ".eslintrc.json"})
        self.assertIsNotNone(result)
        self.assertIn("BLOCKED", result)
        # Should have emitted the fallback warning
        runtime_warnings = [w for w in caught if issubclass(w.category, RuntimeWarning)]
        self.assertEqual(1, len(runtime_warnings))
        self.assertIn("Node.js", str(runtime_warnings[0].message))

    def test_no_node_falls_back_to_python(self):
        """When node binary is not found, PolicyGate falls back to Python evaluation."""
        import warnings
        from flow_agents_strands import policy as policy_module

        # Passing None explicitly overrides module-level resolution, forcing fallback
        gate = policy_module.PolicyGate(_node_bin=None, _run_hook_path="/fake/run-hook.js")
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            result = gate.check_tool_call("write", {"path": ".eslintrc.json"})
        self.assertIsNotNone(result)
        self.assertIn("BLOCKED", result)


# ============================================================================
# End-to-end test — invokes the actual Node.js engine
# ============================================================================


class TestPolicyGateEndToEnd(unittest.TestCase):
    """
    Real end-to-end test: invokes the actual node engine via subprocess.

    Skipped gracefully if node is not available or the engine script cannot
    be located.
    """

    @classmethod
    def setUpClass(cls):
        """Resolve engine paths once; skip the whole class if unavailable."""
        import shutil
        from flow_agents_strands.policy import _find_engine_paths

        node, run_hook = _find_engine_paths()
        if not node or not run_hook:
            raise unittest.SkipTest(
                "Node.js or the Flow Agents engine script (run-hook.js) is not available. "
                "Skipping end-to-end policy tests."
            )
        cls._node_bin = node
        cls._run_hook_path = run_hook

    def _make_gate(self):
        from flow_agents_strands.policy import PolicyGate
        return PolicyGate(_node_bin=self._node_bin, _run_hook_path=self._run_hook_path)

    def test_e2e_blocks_eslintrc_write(self):
        """Real engine call: blocks write to .eslintrc.json."""
        gate = self._make_gate()
        reason = gate.check_tool_call("write", {"path": "/repo/.eslintrc.json"})
        self.assertIsNotNone(reason, "Expected engine to block .eslintrc.json write")
        self.assertIn("BLOCKED", reason)
        self.assertIn(".eslintrc.json", reason)

    def test_e2e_allows_safe_file_write(self):
        """Real engine call: allows write to src/main.ts."""
        gate = self._make_gate()
        result = gate.check_tool_call("write", {"path": "src/main.ts"})
        self.assertIsNone(result, "Expected engine to allow src/main.ts write")

    def test_e2e_allows_read_on_protected_file(self):
        """Real engine call: read tools bypass the engine (tool-name pre-filter)."""
        gate = self._make_gate()
        result = gate.check_tool_call("read", {"path": ".eslintrc.json"})
        self.assertIsNone(result, "Read on protected file must never be blocked")

    def test_e2e_blocks_biome_json_via_file_path_key(self):
        """Real engine call: blocks edit to biome.json using file_path key."""
        gate = self._make_gate()
        reason = gate.check_tool_call("edit", {"file_path": "biome.json"})
        self.assertIsNotNone(reason)
        self.assertIn("biome.json", reason)


if __name__ == "__main__":
    unittest.main()
