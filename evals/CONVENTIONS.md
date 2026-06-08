# Eval Conventions

## Naming

### Case Files
- `cases/<agent>/<skill>.yaml` — one file per skill being tested
- `cases/<agent>/promptfooconfig.yaml` — aggregates all cases for that agent
- `promptfooconfig.yaml` — legacy combined config for targeted manual runs only

### Assertions
- `lib/assertions/<check-name>.js` — kebab-case, descriptive verb
- Export a single function matching promptfoo's custom assertion interface

### Results
- `results/<agent>-<date>.json` — promptfoo output per run
- `results/reports/<date>-summary.md` — generated report

## Storage

```
evals/
├── cases/<agent>/
│   ├── promptfooconfig.yaml    # Main config (imports case files)
│   └── <skill>.yaml            # Case definitions per skill
├── lib/assertions/             # Code graders (JS)
├── lib/eval-dev.sh             # Runtime-neutral exec provider example
├── lib/kiro-dev.sh             # Thin Kiro wrapper example
├── lib/codex-provider.sh       # Codex provider wrapper
├── results/                    # Raw promptfoo output (gitignored)
│   └── reports/                # Generated summaries (committed)
├── ARCHITECTURE.md             # Design and vision
├── CONVENTIONS.md              # This file
├── README.md                   # Quick start
└── run.sh                      # Entry point
```

## Adding a New Eval Case

1. Create or edit `cases/<agent>/<skill>.yaml`
2. Add the test entry with `vars`, `assert`, and `metadata`
3. Include at least one code grader (deterministic) and one model grader (workflow compliance)
4. Tag with `metadata.type: capability` or `regression`
5. Add the case to `cases/<agent>/promptfooconfig.yaml` if not auto-imported
6. Run: `bash evals/run.sh llm <agent>` from the repo root to verify

## Coverage Rules

- Document new suites in `README.md` and `ARCHITECTURE.md` when they become runnable through `run.sh`.
- Keep deferred or historical behavior explicitly labeled as deferred or legacy.
- Do not reference removed providers or tools from active configs.
- Prefer per-agent configs under `cases/`; keep the root config small and legacy-compatible.

## Grader Selection Checklist

- [ ] Can I verify this with telemetry events? → `delegated-to.js` or `tool-called.js`
- [ ] Is there a structural constraint? → `no-write-tools.js` or `max-tool-calls.js`
- [ ] Do I need to evaluate reasoning quality? → `llm-rubric`
- [ ] Is this security-sensitive? → add `metadata.human_review: true`
