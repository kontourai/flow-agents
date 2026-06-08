# Go Rules

Loaded on-demand when working in Go projects.

## Error Handling
- Check every error — no `_` for error returns unless explicitly justified
- Wrap errors with context: `fmt.Errorf("doing X: %w", err)`
- Use `errors.Is` / `errors.As` for comparison — never string matching
- Sentinel errors as package-level `var` for expected conditions
- Return errors, don't panic — reserve `panic` for truly unrecoverable states

## Testing
- Table-driven tests as the default pattern
- Use `testify/assert` or `testify/require` for readable assertions
- `t.Helper()` in test helper functions
- `t.Parallel()` for independent tests
- Benchmarks (`Benchmark*`) for performance-sensitive code

## Tooling
- `go vet` + `golangci-lint` with default linters enabled
- `gofmt` / `goimports` for formatting (non-negotiable)
- `go mod tidy` before every commit

## Patterns
- Accept interfaces, return structs
- `context.Context` as first parameter for cancellation and deadlines
- Prefer small interfaces (1-3 methods) for testability
- Use `sync.Once` for lazy initialization, not `init()`
- Channel direction in function signatures: `chan<-` or `<-chan`
- Prefer `slog` (Go 1.21+) for structured logging
- Embed structs for composition, not inheritance
