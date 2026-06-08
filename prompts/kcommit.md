---
description: Group outstanding changes into logical commits following project conventions
---
# Smart Commit

Analyze all outstanding changes in the working directory and organize them into logical, well-structured commits.

## Workflow

### Phase 1: ASSESS
1. Run `git status` to see all modified, added, deleted, and untracked files
2. Run `git diff` to understand the actual content changes (staged and unstaged)
3. Run `git diff --cached` to see what's already staged
4. **Triage untracked files** — for each untracked file/directory:
   - Inspect its contents to understand what it is
   - Check `.gitignore` to see if it *should* be ignored but isn't (→ suggest adding to `.gitignore`)
   - Check if it contains secrets, credentials, build artifacts, or local-only state (→ suggest adding to `.gitignore`, do NOT commit)
   - If it's legitimate project content (source, config, docs, skills) → include it in the commit plan
   - If uncertain → ask the user whether to commit, ignore, or skip
5. If there are no changes (tracked or untracked), inform the user and exit

### Phase 2: DETECT COMMIT CONVENTIONS
1. Check for project-level commit conventions:
   - Read `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `.github/COMMIT_CONVENTION.md` or similar
   - Check for commitlint config (`.commitlintrc`, `commitlint.config.js`, etc.)
   - Check for `.czrc` or `cz.json` (commitizen config)
   - Check `package.json` for commit-related config
2. If project conventions found, use those
3. If none found, default to [Conventional Commits](https://www.conventionalcommits.org/):
   - Format: `<type>(<scope>): <description>`
   - Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
   - Lowercase, imperative mood, no period, under 72 chars
   - Append `!` after type/scope for breaking changes

### Phase 3: GROUP CHANGES
Analyze the changes and group them into logical commits based on:
- **Functional cohesion**: Changes that serve the same purpose belong together
- **File proximity**: Related files in the same module/feature area
- **Change type**: Separate features from fixes from refactors from docs
- **Dependencies**: If change B depends on change A, A commits first

Grouping rules:
- New feature files + their tests = one commit
- Config changes that support a feature = same commit as the feature OR separate if they're independently meaningful
- Unrelated bug fixes = separate commits
- Formatting/style-only changes = separate commit
- Documentation updates = separate commit unless they document a feature in the same batch

### Phase 4: PROPOSE PLAN
Present the commit plan as a numbered list:

```
Proposed commits (in order):

1. feat(auth): add jwt token refresh endpoint
   - src/auth/refresh.ts (new)
   - src/auth/refresh.test.ts (new)
   - src/auth/index.ts (modified - export)

2. fix(api): handle null response in user lookup
   - src/api/users.ts (modified)
```

If running interactively, ask the user to confirm, modify, or reorder before proceeding.
If running non-interactively, proceed directly with your best judgment.

### Phase 5: EXECUTE
For each commit group, in order:
1. `git reset HEAD` (unstage everything first, only on first iteration)
2. `git add <files>` for only the files in this group
3. `git diff --cached --stat` to verify staged files match the group
4. `git commit -m "<message>"`
   - If a commit body is warranted (breaking change, complex change), use `-m "<subject>" -m "<body>"`
5. Verify commit succeeded before moving to next group

### Phase 6: VERIFY
1. Run `git log --oneline -n <count>` to show the new commits
2. Run `git status` to confirm working directory is clean (or show remaining untracked files)
3. Note: commits are local only, no push was performed

## Rules
- NEVER push to remote — local commits only
- NEVER force-add files that are in .gitignore
- NEVER commit secrets, credentials, or .env files
- NEVER amend or rebase existing commits unless explicitly asked
- If a file has mixed changes (part feature, part fix), ask the user whether to split with `git add -p` or keep together (if interactive), otherwise keep it in the commit where the primary change belongs
- Preserve any already-staged changes as a potential first commit group
- When in doubt about grouping, prefer fewer larger logical commits over many tiny ones
