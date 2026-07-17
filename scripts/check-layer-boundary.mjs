#!/usr/bin/env node
/**
 * check-layer-boundary — kit/engine layer-doctrine ratchet.
 *
 * Doctrine (veritas docs/architecture/engine-surface-seam.md, Invariant 3; ADR 0008/0016):
 * kits distribute by copy/activate/CLI and consume a product engine via CLI + artifacts, NEVER
 * as an npm library import. A kit that `import`s the veritas evaluation engine would fork the
 * layer boundary — the kit must wrap the engine's CLI, not link its code. This is the executable
 * enforcement of that invariant (flow-agents#651).
 *
 * FAILS if any tracked file under kits/ imports `@kontourai/veritas` (or its `/engine` subpath),
 * or if any kit.json declares it as a dependency. The kit's trust-bundle adapter may import
 * `@kontourai/surface` (the open trust format, Layer 3) — that is the sanctioned channel and is
 * NOT matched here. No allowlist: the count is zero today and must stay zero.
 *
 * Not a violation (and not matched — import-syntax-scoped): the many descriptive strings naming
 * "@kontourai/veritas" in kit.json descriptions, docs, and recorded CLI-output fixtures are prose
 * and data, not code imports.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Match import/require/dynamic-import of the veritas package (root or /engine subpath) only, so
// prose/fixture mentions of the package name can never trip it — only an actual code link does.
const PKG = String.raw`@kontourai/veritas(?:/[A-Za-z0-9_./-]+)?`;
const IMPORT_PATTERNS = [
  new RegExp(String.raw`from\s+['"](?:${PKG})['"]`),
  new RegExp(String.raw`require(?:\.resolve)?\(\s*['"](?:${PKG})['"]\s*\)`),
  new RegExp(String.raw`import\(\s*['"](?:${PKG})['"]\s*\)`),
];
const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js|jsx)$/;

// Strip comments so an import-SHAPED example inside a doc comment (e.g. a JSDoc `* import ...`
// line) is not a false positive. A real import statement never starts a line with `//` or `*`,
// so this only removes prose, never a genuine dependency edge. (Line-scoped — not a full parser;
// a package name inside a string literal remains matchable, which is intentional.)
function codeOnly(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
}

function trackedFiles(dir) {
  return execFileSync("git", ["ls-files", dir], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const violations = [];

// 1. Source imports under kits/.
for (const file of trackedFiles("kits").filter((f) => SOURCE_EXT.test(f))) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    if (IMPORT_PATTERNS.some((re) => re.test(codeOnly(line)))) {
      violations.push(`${file}:${index + 1}  imports @kontourai/veritas — kits wrap the engine via CLI, not as a library`);
    }
  });
}

// 2. kit.json dependency declarations.
for (const file of trackedFiles("kits").filter((f) => f.endsWith("kit.json"))) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const decl = manifest[field];
    if (decl && typeof decl === "object" && !Array.isArray(decl)) {
      for (const name of ["@kontourai/veritas"]) {
        if (Object.prototype.hasOwnProperty.call(decl, name)) {
          violations.push(`${file} ${field}.${name} — a kit must not declare the engine as an npm dependency`);
        }
      }
    }
  }
}

if (violations.length) {
  console.error("[check-layer-boundary] FAILED — a kit imports/depends on the veritas engine as a library (engine/surface seam, Invariant 3):");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nKits distribute by copy/activate/CLI and consume the engine via its CLI + recorded artifacts,\n" +
      "never as an npm library import. The trust-bundle adapter may import @kontourai/surface (the open\n" +
      "trust format); it must not import @kontourai/veritas. See veritas docs/architecture/engine-surface-seam.md.",
  );
  process.exitCode = 1;
} else {
  console.log("[check-layer-boundary] OK — no kit imports or declares the veritas engine as a library.");
}
