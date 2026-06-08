# Code Review Standards

Standards for ALL agents to follow when reviewing or writing code.

## Review Checklist

- [ ] Readable, well-named variables/functions
- [ ] Functions < 50 lines
- [ ] Files < 800 lines
- [ ] Nesting < 4 levels
- [ ] Errors handled at every level — never silently swallowed
- [ ] No hardcoded secrets or credentials
- [ ] No debug statements (`console.log`, `debugger`, `print`)
- [ ] Tests exist for new/changed logic
- [ ] Coverage >= 80%

## Severity Levels

| Severity | Scope | Action |
|---|---|---|
| CRITICAL | Security vulnerabilities, data loss, auth bypass | BLOCK — must fix before merge |
| HIGH | Bugs, broken logic, missing error handling | WARN — should fix before merge |
| MEDIUM | Maintainability, duplication, unclear naming | INFO — fix when practical |
| LOW | Style, formatting, minor conventions | NOTE — optional |

## Mandatory Review Triggers

- After writing or modifying code
- Before commits to shared branches
- Security-sensitive changes (auth, payments, user data)
- Architectural changes (new services, schema changes, API contracts)

## Security Review Triggers

Review with extra scrutiny when changes touch:
- Authentication / authorization logic
- User input handling or validation
- Database queries (especially dynamic/constructed)
- File system operations
- External API calls or webhook handlers
- Cryptographic operations
- Payment or billing code

## Common Issues to Catch

### Security
- Hardcoded credentials or API keys
- SQL injection (unsanitized input in queries)
- XSS (unescaped user content in HTML)
- Path traversal (unsanitized file paths)
- CSRF (missing token validation on state-changing requests)

### Code Quality
- Functions or files exceeding size limits
- Deep nesting (> 4 levels) — extract helper functions
- Missing error handling or silent catch blocks
- Direct mutation of shared state — use immutable patterns

### Performance
- N+1 queries — batch or join instead
- Missing pagination on list endpoints
- Unbounded queries (no LIMIT, no max results)
