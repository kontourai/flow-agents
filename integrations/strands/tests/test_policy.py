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
