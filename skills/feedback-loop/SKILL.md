---
name: "feedback-loop"
description: "Verify implementation actually works. Visual changes → Playwright; integration changes → commands/tests. Run after completing builds."
---

# Feedback Loop

Verify that what you claim to have built actually works. Don't just say "done" — prove it.

## When to Use

- After implementing changes, before declaring them complete
- When the user asks you to verify or prove your work
- As the final step of any implementation workflow
- When you're uncertain whether your changes actually function correctly

## Workflow

### Step 1: IDENTIFY CHANGES

Determine what was just built:
- Check `git diff` for modified/added files
- Review the active TODO list for context on what was implemented
- Identify the nature of the change: what should be different now?

### Step 2: CLASSIFY

Determine the verification method:

| Change Type | Method | Examples |
|---|---|---|
| **Visual** | Playwright via `tool-playwright` | UI components, pages, styles, layouts, forms, visual regressions |
| **Integration** | Commands, tests, execution | APIs, CLIs, libraries, configs, build scripts, data processing |

If changes span both, run both verification paths.

### Step 3: VERIFY

#### Visual Path (frontend/UI changes)
Delegate to `tool-playwright`:
1. Load the relevant URL (local dev server, preview, etc.)
2. Take an accessibility snapshot to confirm elements exist and are structured correctly
3. Take a screenshot for visual confirmation
4. If interactive — click, type, navigate to exercise the changed behavior
5. Compare against expected state: are the right elements present? Does the layout match intent?

If the dev server isn't running, start it (or tell the user to) before proceeding.

#### Integration Path (non-visual changes)
Use the most direct verification available, in priority order:
1. **Run existing tests** — if tests cover the changed code, run them
2. **Execute the code** — run the CLI command, call the API endpoint, import the module
3. **Check build** — compile/lint to confirm no syntax or type errors
4. **Inspect output** — verify the output matches expected behavior

Always capture actual output as evidence.

### Step 4: REPORT

State clearly:
- **What was verified** — which changes, which method
- **Evidence** — actual output, screenshots, test results, command output
- **Verdict** — ✅ confirmed working, or ❌ found issues with specifics

If verification fails, fix the issue and re-verify. Don't report failure without attempting a fix first.

## Persistence Rule

**Keep trying until the user says stop.** This is the core behavior of the feedback loop.

- If a verification method fails (Playwright won't connect, tests error out, server won't start), **debug and retry**. Don't downgrade to a weaker method or declare "good enough."
- If visual verification is required and Playwright is having issues, fix the Playwright issue. Don't fall back to "well the build passes so it's probably fine."
- If integration tests fail, diagnose why, fix, and re-run. Don't report partial success.
- Cycle: **verify → fail → diagnose → fix → verify again**. Repeat until either:
  1. ✅ All verification methods pass with evidence, OR
  2. 🛑 The user explicitly says to stop or skip a method

Never self-exit the loop. Never decide on the AI's behalf that a failure is acceptable. The user breaks the loop, not the agent.

## Key Principles

- **Evidence over assertion.** Show output, not just "it works."
- **Never settle.** If a verification method should work but isn't, that's a bug to fix — not a reason to skip it.
- **Fix before reporting.** If verification reveals a bug you introduced, fix it and re-run.
- **Match the medium.** UI changes need visual proof. Backend changes need execution proof.
- **Be specific.** "Tests pass" is weak. "Ran `npm test` — 14 tests passed, 0 failed, output attached" is strong.
- **Don't skip this.** The whole point is catching the gap between "I wrote the code" and "the code works."
