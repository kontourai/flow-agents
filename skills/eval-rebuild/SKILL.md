---
name: "eval-rebuild"
description: "Project-specific build and install commands for the eval feedback loop. Injected into eval-builder agent. Replace this skill for different build systems."
---

# Eval Rebuild

This skill defines how to rebuild and reinstall agents after making source edits. The eval-builder agent calls this after fixing a prompt or skill.

## Build System

This project uses a flat standalone structure — no build step required. Edits to agent specs, skills, and context take effect immediately.

## Source & Installed Locations (same)

| What | Where |
|------|-------|
| Agent configs | `~/.flow-agents/agents/*.json` |
| Skills | `~/.flow-agents/skills/*/SKILL.md` |
| Context files | `~/.flow-agents/context/**/*.md` |
| Evals | `~/.flow-agents/evals/` |

## Rebuild Commands

No rebuild needed — edits are live. If Claude Code caches agent configs, restart the session.

## Post-Edit Verification

```bash
bash ~/.flow-agents/evals/run.sh static
```

## Adapting for Other Projects

To use the eval framework with a different build system, replace this skill with one that defines your project's:
1. Source locations (where agent specs and skills live)
2. Rebuild commands (your build + install pipeline)
3. Post-rebuild verification (how to check it worked)
4. Installed locations (where the runtime reads agent configs from)
