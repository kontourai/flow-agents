"""
policy.py — Policy gates for BeforeToolCallEvent.

Primary binding: subprocess to the canonical Node.js engine
(scripts/hooks/run-hook.js → config-protection.js) for the authoritative
policy decision.  The tool-name pre-filter (write-like tools only) is applied
in Python before calling the engine, since the engine itself does not filter by
tool name — it blocks on the file basename alone.

Fallback: if Node.js is absent or the engine script cannot be located, the gate
degrades to the pure-Python implementation of the same logic and emits a
one-time RuntimeWarning.  See README.md §Limitations.

Engine contract (contract_version "1.0"):
  - Payload: JSON on stdin with hook_event_name, tool_name, tool_input fields.
  - Exit code 0 = allow, exit code 2 = block, other = error (fail-open).
  - Stderr carries the block reason when exit code is 2.
  - See docs/spec/runtime-hook-surface.md §8 for the full contract.

Custom protected_files: when the caller passes a non-default ``protected_files``
frozenset, the engine subprocess is bypassed and the Python evaluation is used
directly (the subprocess cannot receive a runtime-custom set).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import warnings
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Locate the canonical engine — supports both installed-package and repo layouts.
# ---------------------------------------------------------------------------

def _find_engine_paths() -> tuple[Optional[str], Optional[str]]:
    """
    Return (node_executable, run_hook_path) or (None, None) if unavailable.

    Search order for run-hook.js:
      1. Env var FLOW_AGENTS_ENGINE_PATH (explicit override).
      2. Relative to this file: ../../../../scripts/hooks/run-hook.js
         (works when running from the source repo checkout).
      3. Installed via npm: walk up from CWD looking for
         node_modules/@kontourai/flow-agents/scripts/hooks/run-hook.js
    """
    node = shutil.which("node")
    if not node:
        return None, None

    # 1. Explicit override
    env_path = os.environ.get("FLOW_AGENTS_ENGINE_PATH")
    if env_path:
        p = Path(env_path)
        if p.is_file():
            return node, str(p)

    # 2. Relative to this source file (repo checkout: integrations/strands/flow_agents_strands/)
    candidate = Path(__file__).parent.parent.parent.parent / "scripts" / "hooks" / "run-hook.js"
    if candidate.is_file():
        return node, str(candidate)

    # 3. npm-installed package layout
    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        candidate = (
            parent / "node_modules" / "@kontourai" / "flow-agents" / "scripts" / "hooks" / "run-hook.js"
        )
        if candidate.is_file():
            return node, str(candidate)

    return node, None


# Resolved at module import time; callers can override via constructor parameters.
_NODE_BIN, _RUN_HOOK_PATH = _find_engine_paths()


# Sentinel for "not provided" constructor parameters
_UNSET = object()

# ---------------------------------------------------------------------------
# Pure-Python fallback — mirrors config-protection.js PROTECTED_FILES
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

# Write-like tool names — both the engine and the Python fallback only gate
# write-like tools.  Reads on protected files are always allowed.
_WRITE_TOOLS = frozenset(
    {
        "edit",
        "write",
        "fs_write",
        "apply_patch",
        "create_file",
        "str_replace_editor",
    }
)


def _python_config_protection(
    tool_name: str,
    tool_input: dict,
    protected: frozenset = PROTECTED_FILES,
) -> Optional[str]:
    """
    Pure-Python evaluation of config-protection.

    Mirrors the logic in scripts/hooks/config-protection.js.
    Called when Node.js is unavailable or a custom protected set is in use.
    """
    if tool_name.lower() not in _WRITE_TOOLS:
        return None
    file_path = tool_input.get("path") or tool_input.get("file_path") or ""
    if not file_path:
        return None
    basename = Path(file_path).name
    if basename in protected:
        return _BLOCK_REASON_TEMPLATE.format(basename=basename)
    return None


# ---------------------------------------------------------------------------
# Subprocess binding to the engine contract
# ---------------------------------------------------------------------------

def _invoke_engine(
    hook_id: str,
    hook_script: str,
    payload: dict,
    *,
    node_bin: str,
    run_hook_path: str,
    extra_env: Optional[dict] = None,
) -> tuple[int, str, str]:
    """
    Invoke the canonical engine via subprocess.

    Returns (exit_code, stdout, stderr).
    On subprocess errors returns (1, "", "<error>") so callers can fail-open.
    """
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    env["FLOW_AGENTS_HOOK_RUNTIME"] = "strands"

    # run-hook.js resolves hook_script relative to its own directory
    hooks_dir = str(Path(run_hook_path).parent)

    try:
        result = subprocess.run(
            [node_bin, run_hook_path, hook_id, hook_script],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
            cwd=hooks_dir,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "[policy] engine subprocess timed out"
    except OSError as exc:
        return 1, "", f"[policy] engine subprocess failed: {exc}"


# ---------------------------------------------------------------------------
# PolicyGate
# ---------------------------------------------------------------------------


class PolicyGate:
    """
    Evaluates tool-call policy gates.

    Designed for use inside BeforeToolCallEvent callbacks; does NOT depend on
    any Strands import so it is fully testable without the SDK installed.

    Primary mode: spawns ``node run-hook.js config-protection.js`` to delegate
    to the engine contract (contract_version "1.0").  The tool-name pre-filter
    is applied in Python before calling the engine.

    Fallback mode: if Node.js or the engine script is unavailable, degrades to
    the built-in Python implementation and emits a one-time RuntimeWarning.

    Custom protected_files: if a non-default frozenset is passed, Python
    evaluation is used directly (the engine subprocess cannot accept a
    runtime-custom set).  This is intended for tests and local override only.

    The ``_node_bin`` and ``_run_hook_path`` constructor parameters allow tests
    to inject fakes without touching the filesystem.
    """

    def __init__(
        self,
        protected_files: Optional[frozenset] = None,
        _node_bin: object = _UNSET,
        _run_hook_path: object = _UNSET,
    ) -> None:
        # Allow tests to inject explicit values (including None to force fallback).
        # _UNSET means "use the module-level resolved value".
        self._node_bin: Optional[str] = (
            _node_bin if _node_bin is not _UNSET else _NODE_BIN  # type: ignore[assignment]
        )
        self._run_hook_path: Optional[str] = (
            _run_hook_path if _run_hook_path is not _UNSET else _RUN_HOOK_PATH  # type: ignore[assignment]
        )
        # Custom protected set: bypass engine subprocess, use Python directly.
        self._custom_protected: Optional[frozenset] = protected_files
        self._warned_fallback = False

    @property
    def _engine_available(self) -> bool:
        return bool(self._node_bin and self._run_hook_path)

    def _warn_fallback(self) -> None:
        if not self._warned_fallback:
            self._warned_fallback = True
            warnings.warn(
                "flow-agents-strands: Node.js or the Flow Agents engine script is "
                "not available. Policy gates are degrading to the built-in Python "
                "fallback (fail-open for unknown cases). Install Node.js and ensure "
                "the @kontourai/flow-agents package is reachable to use the canonical "
                "engine contract. See README.md §Limitations.",
                RuntimeWarning,
                stacklevel=4,
            )

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
        """
        Invoke config-protection.

        Tool-name pre-filter: only write-like tools are gated.  Reads on
        protected files are always allowed (this is the same rule as the JS
        engine — the engine short-circuits for the same reason; the pre-filter
        avoids the subprocess round-trip for non-write tools).

        If a custom protected_files set was passed to the constructor, Python
        evaluation is used instead of the engine subprocess.

        If Node.js or the engine script is unavailable, falls back to Python
        evaluation with the default PROTECTED_FILES set.
        """
        # Tool-name pre-filter (read tools always allowed)
        if tool_name.lower() not in _WRITE_TOOLS:
            return None

        # Custom protected set → Python evaluation only
        if self._custom_protected is not None:
            return _python_config_protection(tool_name, tool_input, self._custom_protected)

        # Engine subprocess → authoritative decision
        if self._engine_available:
            payload = {
                "hook_event_name": "PreToolUse",
                "tool_name": tool_name,
                "tool_input": tool_input,
            }

            exit_code, stdout, stderr = _invoke_engine(
                hook_id="config-protection",
                hook_script="config-protection.js",
                payload=payload,
                node_bin=self._node_bin,
                run_hook_path=self._run_hook_path,
            )

            if exit_code == 2:
                reason = stderr.strip() or stdout.strip() or "BLOCKED: config-protection policy blocked this action."
                return reason

            if exit_code == 0:
                return None

            # Engine error (exit_code not 0 or 2) → fail-open
            return None

        # No engine available → Python fallback
        self._warn_fallback()
        return _python_config_protection(tool_name, tool_input)
