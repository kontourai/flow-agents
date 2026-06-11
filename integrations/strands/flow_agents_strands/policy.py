"""
policy.py — Policy gates for BeforeToolCallEvent.

Implements the config-protection semantic from scripts/hooks/config-protection.js,
reimplemented in pure Python (no shell-out) so it works without Node.js.

The JS hook is the canonical reference; this Python version mirrors the same
PROTECTED_FILES set and the same block message.  We chose pure-Python rather
than shelling out to the JS script because:

  1. The Strands SDK is a Python runtime; introducing a mandatory Node.js
     subprocess would add a heavy external dependency with no gain.
  2. The PROTECTED_FILES list is a closed constant — it does not read config
     from disk at runtime — so faithfully translating it to Python is safe and
     trivially auditable.
  3. A pure-Python gate runs synchronously and cannot deadlock the agent loop
     the way a subprocess could in a tight hook callback.

If future policies need the full JS hook contract (e.g. quality-gate.js which
invokes ruff/biome), the shell-out approach would be appropriate then.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Protected config files — mirrors config-protection.js PROTECTED_FILES
# ---------------------------------------------------------------------------

PROTECTED_FILES = frozenset(
    [
        # ESLint
        ".eslintrc",
        ".eslintrc.js",
        ".eslintrc.cjs",
        ".eslintrc.json",
        ".eslintrc.yml",
        ".eslintrc.yaml",
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.cjs",
        "eslint.config.ts",
        "eslint.config.mts",
        "eslint.config.cts",
        # Prettier
        ".prettierrc",
        ".prettierrc.js",
        ".prettierrc.cjs",
        ".prettierrc.json",
        ".prettierrc.yml",
        ".prettierrc.yaml",
        "prettier.config.js",
        "prettier.config.cjs",
        "prettier.config.mjs",
        # Biome
        "biome.json",
        "biome.jsonc",
        # Ruff
        ".ruff.toml",
        "ruff.toml",
        # Others
        ".shellcheckrc",
        ".stylelintrc",
        ".stylelintrc.json",
        ".stylelintrc.yml",
        ".markdownlint.json",
        ".markdownlint.yaml",
        ".markdownlintrc",
    ]
)

_BLOCK_REASON_TEMPLATE = (
    "BLOCKED: Modifying {basename} is not allowed. "
    "Fix the source code to satisfy linter/formatter rules instead of "
    "weakening the config. If this is a legitimate config change, "
    "disable the config-protection policy gate temporarily."
)


class PolicyGate:
    """
    Evaluates tool-call policy gates.

    Designed for use inside BeforeToolCallEvent callbacks; does NOT depend on
    any Strands import so it is fully testable without the SDK installed.
    """

    def __init__(self, protected_files: Optional[frozenset] = None) -> None:
        self._protected = protected_files if protected_files is not None else PROTECTED_FILES

    def check_tool_call(
        self,
        tool_name: str,
        tool_input: dict,
    ) -> Optional[str]:
        """
        Evaluate policy for a tool call.

        Returns None if the call is allowed, or a block-reason string if it
        should be cancelled (the string becomes the cancel_tool message).
        """
        return self._check_config_protection(tool_name, tool_input)

    def _check_config_protection(
        self,
        tool_name: str,
        tool_input: dict,
    ) -> Optional[str]:
        """Mirror config-protection.js: block writes to protected config files."""
        # Only gate write-like tools
        if tool_name.lower() not in {
            "edit",
            "write",
            "fs_write",
            "apply_patch",
            "create_file",
            "str_replace_editor",
        }:
            return None

        file_path = tool_input.get("path") or tool_input.get("file_path") or ""
        if not file_path:
            return None

        basename = Path(file_path).name
        if basename in self._protected:
            return _BLOCK_REASON_TEMPLATE.format(basename=basename)

        return None
