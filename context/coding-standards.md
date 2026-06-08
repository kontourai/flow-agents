# Coding Standards

Standards for ALL agents to follow when writing code.

## Immutability

Always create new objects — never mutate existing ones.
- Prevents side effects and hidden state bugs
- Safe for concurrent access without locks
- Use spread operators, `Object.freeze`, or immutable data structures

## File Organization

- Many small files > few large files
- Typical file: 200–400 lines. Hard max: 800 lines
- Organize by feature/domain, not by type (e.g., `auth/` not `controllers/`)
- One export per file when practical — colocate related helpers

## Error Handling

- Handle errors at every level — never silently swallow
- UI: user-friendly messages, no stack traces
- Server-side: detailed context (what failed, input state, upstream cause)
- Fail fast on unrecoverable errors — don't limp along with bad state
- Always clean up resources (connections, file handles) in finally blocks

## Input Validation

- Validate at system boundaries (API endpoints, CLI args, file reads, external data)
- Use schema-based validation where available (Zod, JSON Schema, etc.)
- Fail fast with clear error messages — include what was wrong and what's expected
- Never trust external data — validate type, range, format, and length

## Code Quality Checklist

- [ ] Readable, well-named (variables, functions, files)
- [ ] Functions < 50 lines
- [ ] Files < 800 lines
- [ ] Nesting < 4 levels deep
- [ ] Errors handled properly at every level
- [ ] No hardcoded values (secrets, URLs, magic numbers)
- [ ] Immutable patterns used — no direct mutation of shared state
