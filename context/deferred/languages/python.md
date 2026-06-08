# Python Rules

Loaded on-demand when working in Python projects.

## Types
- Type hints on all function signatures — no untyped public APIs
- Use `from __future__ import annotations` for forward references
- `typing.Protocol` for structural subtyping over ABC where possible

## Validation
- Pydantic for runtime validation of external inputs (API payloads, config, env vars)
- Dataclasses or attrs for internal data structures (no plain dicts for structured data)

## Testing
- pytest as the test framework — no unittest
- Co-locate tests in `tests/` mirroring `src/` structure
- Use fixtures over setup/teardown methods
- `pytest-cov` for coverage reporting

## Tooling
- Ruff for linting and formatting (replaces flake8 + black + isort)
- `pyproject.toml` as the single config file
- Type checking with mypy or pyright in strict mode

## Patterns
- Use `async/await` where I/O bound (httpx, database, file ops)
- Prefer `pathlib.Path` over `os.path`
- Use context managers (`with`) for resource cleanup
- Prefer `enum.Enum` over string constants
- Use `logging` module with structured output — no `print()` in library code
- Virtual environments always — never install to system Python
