# Demo Mode

Speed over polish. For customer demos, workshops, and prototypes.

## When to Activate
- User says "demo", "prototype", "workshop", "spike", "proof of concept", or "POC"
- Explicitly requested: "use demo mode"

## Relaxed Quality Gates
- Skip TDD — write tests only for critical paths if time allows
- Skip code review — no tool-verifier pass required
- Minimal validation — "it runs and looks right" is sufficient
- Skip linting/formatting enforcement

## Quick-Start Patterns

| Language | Stack | Command |
|----------|-------|---------|
| TypeScript | Vite + React | `npm create vite@latest -- --template react-ts` |
| Python | FastAPI | `pip install fastapi uvicorn && uvicorn main:app --reload` |
| Go | net/http | Standard library, no framework needed |
| Java | Spring Boot | `spring init --dependencies=web,devtools` |

## Guidelines
- **Visual-first validation** — use Playwright screenshots over unit tests for UI work
- **Framework scaffolding** — prefer `create-*` CLIs and official templates over manual setup
- **Hardcoded config is fine** — no need for env vars or config files in demos
- **Skip abstractions** — inline logic, skip interfaces/factories, keep it flat
- **Copy-paste is acceptable** — DRY doesn't apply to throwaway code

## ⚠️ Boundary

Demo-mode artifacts MUST NOT be committed to production branches. Use a `demo/` or `spike/` branch prefix. If demo code needs to become production code, run the full development workflow from step 0.
