/**
 * policy.ts — Native-import policy gate for BeforeToolCallEvent.
 *
 * Primary binding: NATIVE import of scripts/hooks/config-protection.js via
 * its module.exports.run(raw, opts) API — no subprocess.  This is the key
 * differentiator from the Python adapter which uses a subprocess binding.
 *
 * The run() API contract (from run-hook.js §8.2, Form 2):
 *   run(rawJsonString, { truncated, maxStdin }) → string | { exitCode, stderr?, stdout? }
 *
 * Exit code / return value semantics:
 *   exitCode 0   → allow (return null)
 *   exitCode 2   → block (return block reason string from stderr/stdout)
 *   other/error  → fail-open (return null)
 *
 * Engine location resolution (in priority order):
 *   1. Constructor option `engineRoot` (explicit root dir — if provided but invalid,
 *      stops here and returns null; does NOT fall through to auto-discovery).
 *   2. FLOW_AGENTS_ENGINE_ROOT env var.
 *   3. Relative to this file: ../../../scripts/hooks/ (repo checkout layout).
 *   4. Walk up from cwd: node_modules/@kontourai/flow-agents/scripts/hooks/.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Protected files set — mirrors PROTECTED_FILES in config-protection.js
// Used as fallback when native engine is unavailable.
// ---------------------------------------------------------------------------

export const PROTECTED_FILES: ReadonlySet<string> = new Set([
  // ESLint
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  // Prettier
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  // Biome
  "biome.json",
  "biome.jsonc",
  // Ruff
  ".ruff.toml",
  "ruff.toml",
  // Others
  ".shellcheckrc",
  ".stylelintrc",
  ".stylelintrc.json",
  ".stylelintrc.yml",
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlintrc",
]);

// Write-like tool names — only gate write-like tools; reads are always allowed.
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "fs_write",
  "apply_patch",
  "create_file",
  "str_replace_editor",
]);

const BLOCK_REASON_TEMPLATE = (basename: string): string =>
  `BLOCKED: Modifying ${basename} is not allowed. ` +
  "Fix the source code to satisfy linter/formatter rules instead of " +
  "weakening the config. If this is a legitimate config change, " +
  "disable the config-protection policy gate temporarily.";

// ---------------------------------------------------------------------------
// Engine location resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the hooksDir (directory containing config-protection.js etc).
 *
 * When engineRootOverride is provided:
 *   - If the override is a valid repo root (contains scripts/hooks/run-hook.js):
 *     return that hooksDir.
 *   - If the override is a valid hooks dir itself (contains run-hook.js directly):
 *     return that dir.
 *   - Otherwise: return null. Do NOT fall through to auto-discovery.
 *     This ensures an explicit but invalid override surfaces clearly.
 *
 * When engineRootOverride is absent:
 *   Auto-discover via env var → file-relative → cwd walk.
 */
function resolveHooksDir(engineRootOverride?: string): string | null {
  // 1. Explicit override provided — do not fall through to auto-discovery
  if (engineRootOverride !== undefined) {
    const asRepoRoot = path.join(engineRootOverride, "scripts", "hooks");
    if (fs.existsSync(path.join(asRepoRoot, "run-hook.js"))) {
      return asRepoRoot;
    }
    // Allow engineRoot to point directly at scripts/hooks/
    if (fs.existsSync(path.join(engineRootOverride, "run-hook.js"))) {
      return engineRootOverride;
    }
    return null; // explicit override specified but invalid
  }

  // 2. Env var
  const envRoot = process.env.FLOW_AGENTS_ENGINE_ROOT;
  if (envRoot) {
    const candidate = path.join(envRoot, "scripts", "hooks");
    if (fs.existsSync(path.join(candidate, "run-hook.js"))) return candidate;
    if (fs.existsSync(path.join(envRoot, "run-hook.js"))) return envRoot;
  }

  // 3. Relative to this file (repo checkout layout)
  // __dirname is dist/src/ at runtime, src/ when run as source
  // scripts/hooks/ is relative to the repo root, not this file
  for (const relPath of [
    path.resolve(__dirname, "../../../scripts/hooks"),     // src/ layout (3 up)
    path.resolve(__dirname, "../../../../scripts/hooks"),  // dist/src/ layout (4 up)
  ]) {
    if (fs.existsSync(path.join(relPath, "run-hook.js"))) {
      return relPath;
    }
  }

  // 4. Walk up from cwd looking for npm-installed package
  let current = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(
      current,
      "node_modules",
      "@kontourai",
      "flow-agents",
      "scripts",
      "hooks"
    );
    if (fs.existsSync(path.join(candidate, "run-hook.js"))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Native engine call (Form 2 — module.exports.run())
// ---------------------------------------------------------------------------

interface HookRunOutput {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}

type HookRunResult = string | HookRunOutput;

interface HookModule {
  run(raw: string, options: { truncated: boolean; maxStdin: number }): HookRunResult;
}

function loadHookModule(hooksDir: string, scriptName: string): HookModule | null {
  const scriptPath = path.join(hooksDir, scriptName);
  if (!fs.existsSync(scriptPath)) return null;

  try {
    // Use createRequire for CJS modules from ESM context
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = require(scriptPath) as any;
    if (mod && typeof mod.run === "function") {
      return mod as HookModule;
    }
    return null;
  } catch {
    return null;
  }
}

function interpretRunResult(result: HookRunResult): { exitCode: number; blockReason: string | null } {
  if (typeof result === "string") {
    // String return = stdout pass-through → allow
    return { exitCode: 0, blockReason: null };
  }
  if (result && typeof result === "object") {
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
    if (exitCode === 2) {
      const reason =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        "BLOCKED: config-protection policy blocked this action.";
      return { exitCode: 2, blockReason: reason };
    }
    return { exitCode, blockReason: null };
  }
  return { exitCode: 0, blockReason: null };
}

// ---------------------------------------------------------------------------
// Pure-TS fallback — mirrors the JS config-protection.js logic
// ---------------------------------------------------------------------------

function tsConfigProtection(
  toolName: string,
  toolInput: Record<string, unknown>,
  protectedFiles: ReadonlySet<string> = PROTECTED_FILES
): string | null {
  if (!WRITE_TOOLS.has(toolName.toLowerCase())) return null;

  const filePath =
    (toolInput.path as string | undefined) ||
    (toolInput.file_path as string | undefined) ||
    "";
  if (!filePath) return null;

  const basename = path.basename(filePath);
  if (protectedFiles.has(basename)) {
    return BLOCK_REASON_TEMPLATE(basename);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PolicyGate
// ---------------------------------------------------------------------------

export interface PolicyGateOptions {
  /**
   * Root directory of the @kontourai/flow-agents package (the directory
   * containing scripts/hooks/run-hook.js). Defaults to auto-discovery.
   *
   * If provided but invalid (engine not found there), the gate uses pure-TS
   * fallback and does NOT attempt auto-discovery.
   */
  engineRoot?: string;
  /**
   * Custom set of protected file basenames. When provided, the native engine
   * is bypassed and pure-TS evaluation is used (intended for tests only).
   */
  customProtectedFiles?: ReadonlySet<string>;
  /**
   * If true, suppress the one-time console.warn when falling back to TS evaluation.
   */
  suppressFallbackWarning?: boolean;
}

export class PolicyGate {
  private readonly configProtectionModule: HookModule | null;
  private readonly customProtectedFiles: ReadonlySet<string> | undefined;
  private readonly suppressFallbackWarning: boolean;
  private _warnedFallback = false;

  constructor(options: PolicyGateOptions = {}) {
    this.customProtectedFiles = options.customProtectedFiles;
    this.suppressFallbackWarning = options.suppressFallbackWarning ?? false;

    const hooksDir = resolveHooksDir(options.engineRoot);
    if (hooksDir) {
      this.configProtectionModule = loadHookModule(hooksDir, "config-protection.js");
    } else {
      this.configProtectionModule = null;
    }
  }

  get engineAvailable(): boolean {
    return this.configProtectionModule !== null;
  }

  private warnFallback(): void {
    if (this._warnedFallback || this.suppressFallbackWarning) return;
    this._warnedFallback = true;
    console.warn(
      "[flow-agents-strands] Warning: The Flow Agents policy engine (config-protection.js) " +
        "could not be loaded via native import. Policy gates are degrading to the built-in " +
        "TypeScript fallback (fail-open for unknown cases). " +
        "Set FLOW_AGENTS_ENGINE_ROOT to the @kontourai/flow-agents root directory to " +
        "use the canonical engine. See README.md §Limitations."
    );
  }

  /**
   * Check whether a tool call is allowed by config-protection policy.
   *
   * Returns null if allowed, or a block-reason string if blocked.
   * Always fail-open on errors.
   */
  checkToolCall(
    toolName: string,
    toolInput: Record<string, unknown>
  ): string | null {
    // Tool-name pre-filter: reads are always allowed
    if (!WRITE_TOOLS.has(toolName.toLowerCase())) return null;

    // Custom protected set → pure-TS evaluation only
    if (this.customProtectedFiles !== undefined) {
      return tsConfigProtection(toolName, toolInput, this.customProtectedFiles);
    }

    // Native engine call (the key differentiator vs Python subprocess adapter)
    if (this.configProtectionModule !== null) {
      const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
      });

      try {
        const result = this.configProtectionModule.run(payload, {
          truncated: false,
          maxStdin: 1024 * 1024,
        });
        const { blockReason } = interpretRunResult(result);
        return blockReason;
      } catch {
        // fail-open on native call errors
        return null;
      }
    }

    // Fallback: pure-TS evaluation
    this.warnFallback();
    return tsConfigProtection(toolName, toolInput);
  }
}
