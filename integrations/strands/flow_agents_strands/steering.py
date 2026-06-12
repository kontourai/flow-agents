"""
steering.py — Workflow-steering context loader.

Mirrors the logic in scripts/hooks/workflow-steering.js for reading
.flow-agents/*/state.json and producing a steering text blob.

Unlike the JS version this module does NOT inject into a prompt directly —
Strands' BeforeInvocationEvent does not expose a mutable system_prompt at
callback time.  Instead, the caller is expected to call
FlowAgentsHooks.steering_context() at Agent construction and prepend the
result to the system prompt.  See README.md § Limitations for details.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

# Active statuses that warrant surfacing steering context (mirrors workflow-steering.js)
_ACTIVE_STATUSES = frozenset(
    [
        "new",
        "planning",
        "planned",
        "in_progress",
        "blocked",
        "verifying",
        "verified",
        "needs_decision",
        "not_verified",
        "failed",
        "delivered",
    ]
)

_AMBIENT_STATUSES = frozenset(["blocked", "failed", "needs_decision", "not_verified"])


def _find_repo_root(start: Optional[str] = None) -> Path:
    """Walk up from start until .git or AGENTS.md is found."""
    current = Path(start).resolve() if start else Path.cwd()
    for _ in range(40):
        if (current / ".git").exists() or (current / "AGENTS.md").exists():
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    return Path(start).resolve() if start else Path.cwd()


def _walk_state_files(flow_agents_dir: Path) -> List[Path]:
    """Recursively find all state.json files, skipping archive/ dirs."""
    results: List[Path] = []
    if not flow_agents_dir.exists():
        return results
    for entry in flow_agents_dir.rglob("state.json"):
        if "archive" in entry.parts:
            continue
        results.append(entry)
    return results


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _safe_text(value: Any, max_length: int = 240) -> str:
    text = " ".join(str(value or "").split()).strip()
    if len(text) <= max_length:
        return text
    return text[: max_length - 3] + "..."


def _read_strands_kit_flows(flow_agents_dir: Path) -> List[Dict[str, Any]]:
    """
    Scan .flow-agents/runtime/strands/flows/ for activated kit flow files.

    Returns a list of dicts with keys: kit_id, asset_id, description.
    Files are expected to be JSON with at least an "id" field (and optional
    "description"). The path structure is flows/<kit-id>/<asset-id>.flow.json,
    produced by activateStrandsLocal in src/runtime-adapters.ts (Issue #32,
    Decision Q3: option (a) — new adapter id writes runtime files here so
    the steering layer can discover them without knowing the catalog layout).
    """
    flows_dir = flow_agents_dir / "runtime" / "strands" / "flows"
    if not flows_dir.exists():
        return []
    results: List[Dict[str, Any]] = []
    for flow_file in sorted(flows_dir.rglob("*.flow.json")):
        payload = _read_json(flow_file)
        if payload is None:
            continue
        asset_id = payload.get("id") or flow_file.stem.replace(".flow", "")
        description = payload.get("description") or ""
        # Infer kit_id from the directory component between flows/ and the file
        try:
            rel_parts = flow_file.relative_to(flows_dir).parts
            kit_id = rel_parts[0] if len(rel_parts) >= 2 else ""
        except ValueError:
            kit_id = ""
        results.append({"kit_id": kit_id, "asset_id": asset_id, "description": description})
    return results


class SteeringContext:
    """
    Loads Flow Agents workflow-steering context from .flow-agents/ state files.
    """

    def __init__(self, workspace: Optional[str] = None) -> None:
        self._root = _find_repo_root(workspace)
        self._flow_agents_dir = self._root / ".flow-agents"

    def load(self) -> str:
        """
        Return a steering text string (possibly empty) for the current
        workflow state.  Mirrors the stateSteering() + contextMapSteering()
        output from workflow-steering.js, and also surfaces activated kit
        flows from the strands-local runtime path (Issue #32 AC2).
        """
        parts: List[str] = []

        state_hint = self._state_steering()
        if state_hint:
            parts.append(state_hint)

        ctx_hint = self._context_map_steering()
        if ctx_hint:
            parts.append(ctx_hint)

        kit_flows_hint = self._kit_flows_steering()
        if kit_flows_hint:
            parts.append(kit_flows_hint)

        if not parts:
            return ""

        return "\n\n---\n" + "\n".join(parts) + "\n---"

    def _latest_active_state(self) -> Optional[Dict[str, Any]]:
        candidates = []
        for path in _walk_state_files(self._flow_agents_dir):
            payload = _read_json(path)
            if not payload:
                continue
            if payload.get("status") not in _ACTIVE_STATUSES:
                continue
            try:
                mtime = path.stat().st_mtime_ns
            except OSError:
                continue
            candidates.append((mtime, path, payload))

        if not candidates:
            return None
        candidates.sort(key=lambda t: t[0], reverse=True)
        _, path, payload = candidates[0]
        return {"file": str(path), "payload": payload}

    def _state_steering(self) -> str:
        current = self._latest_active_state()
        if not current:
            return ""
        state = current["payload"]
        next_action = state.get("next_action") or {}

        if next_action.get("status") == "done":
            return ""
        if state.get("status") in ("archived", "accepted"):
            return ""

        task_slug = state.get("task_slug") or Path(current["file"]).parent.name
        parts = [
            f"STATE: {task_slug} is status:{state.get('status')} phase:{state.get('phase')}."
        ]
        if next_action.get("summary"):
            parts.append(
                f"Recorded next_action.summary: \"{_safe_text(next_action['summary'])}\""
            )
        if next_action.get("target_phase"):
            parts.append(f"Target phase: {_safe_text(next_action['target_phase'], 80)}.")
        if (
            next_action.get("status") == "needs_user"
            or state.get("status") in ("needs_decision", "not_verified")
        ):
            parts.append(
                "Do not deliver as complete until the user decision or accepted gap is recorded."
            )
        if state.get("status") == "failed":
            parts.append("Route back through execution, then re-review and re-verify.")

        return " ".join(parts)

    def _context_map_steering(self) -> str:
        map_path = self._root / "docs" / "context-map.md"
        if not map_path.exists():
            return ""
        return (
            "CONTEXT MAP: use docs/context-map.md before broad repo rediscovery. "
            "If structure, commands, schemas, skills, agents, or packs changed, "
            "run `npm run context-map -- --check`."
        )

    def _kit_flows_steering(self) -> str:
        """
        Surface activated kit flows from the strands-local runtime path.

        Reads .flow-agents/runtime/strands/flows/ (written by `flow-kit activate
        --adapter strands-local`) and emits a brief hint listing active kit flows
        by id and description so the agent is aware of available workflow guidance.
        """
        flows = _read_strands_kit_flows(self._flow_agents_dir)
        if not flows:
            return ""
        lines = ["KIT FLOWS: the following kit flows are activated for this workspace:"]
        for flow in flows:
            desc = f" — {_safe_text(flow['description'], 120)}" if flow.get("description") else ""
            lines.append(f"  • {flow['asset_id']}{desc}")
        return "\n".join(lines)
