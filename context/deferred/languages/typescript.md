# TypeScript Rules

Loaded on-demand when working in TypeScript projects.

## Compiler
- `strict: true` always — no exceptions
- Target ES2022+ unless browser compat requires lower

## Types
- Prefer `type` over `interface` for unions and intersections
- `interface` for object shapes that may be extended
- No `any` without a `// eslint-disable` comment explaining why
- Use `unknown` for untyped external data, narrow with type guards
- Prefer `const` and `readonly` — mutability must be intentional

## Validation
- Use Zod for runtime validation of external inputs (API payloads, env vars, config)
- Infer types from Zod schemas (`z.infer<typeof schema>`) — single source of truth

## Testing
- Jest or Vitest (prefer Vitest for new projects)
- Co-locate test files: `foo.ts` → `foo.test.ts`
- Mock external dependencies, not internal modules

## Tooling
- ESLint + Prettier (or Biome as a single tool)
- `@typescript-eslint/strict` ruleset as baseline
- Format on save, lint on commit

## Patterns
- Prefer `async/await` over raw Promises
- Use discriminated unions for state machines
- Barrel exports (`index.ts`) only at package boundaries, not within modules
- Prefer named exports over default exports
