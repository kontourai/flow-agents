#!/usr/bin/env node
/**
 * check-hachure-boundary — portfolio layer-doctrine ratchet.
 *
 * Doctrine (surface/docs/architecture/portfolio-layer-doctrine.md): only Surface
 * may depend on the open trust format (hachure) directly. Products speak the
 * format THROUGH Surface (Surface.validateTrustBundle / validateInquiryRecord /
 * TrustBundleBuilder), so a hachure version can never drift across the suite.
 *
 * This check FAILS if a NEW direct-hachure usage appears in src/ or package.json.
 * Today's known usages are allowlisted below and should be removed as each one
 * migrates onto the Surface OTF read side. It is a ratchet: it does not force the
 * existing migration, it prevents the problem from getting worse.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ── Allowlist: current, pending-migration direct-hachure usage ───────────────
// Remove an entry once its hachure usage is gone (routed through @kontourai/surface).
const ALLOWLISTED_SOURCE_FILES = new Set([
  // Resolves hachure's inquiry-record.schema.json for Ajv validation. Migrates
  // onto Surface.validateInquiryRecord (added in @kontourai/surface) once that
  // version is published — see the Portfolio Layer Doctrine "target" table.
  "src/cli/workflow-sidecar.ts",
]);
// package.json may still declare hachure while a source file above still needs it.
const ALLOW_PACKAGE_JSON_HACHURE_DEP = true;

// No `\b` before `require`: flow-agents calls `_require.resolve("hachure")`
// (an aliased require), so a word-boundary anchor would miss it.
const IMPORT_PATTERNS = [
  /from\s+['"]hachure['"]/,
  /require(\.resolve)?\(\s*['"]hachure['"]\s*\)/,
  /import\(\s*['"]hachure['"]\s*\)/,
];
const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js|jsx)$/;

function trackedSourceFiles() {
  return execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((f) => f && SOURCE_EXT.test(f));
}

const violations = [];

for (const file of trackedSourceFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    if (IMPORT_PATTERNS.some((re) => re.test(line)) && !ALLOWLISTED_SOURCE_FILES.has(file)) {
      violations.push(`${file}:${index + 1}  direct hachure usage — route through @kontourai/surface instead`);
    }
  });
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let pkgDeclaresHachure = false;
for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
  if (pkg[field] && Object.prototype.hasOwnProperty.call(pkg[field], "hachure")) {
    pkgDeclaresHachure = true;
    if (!ALLOW_PACKAGE_JSON_HACHURE_DEP) {
      violations.push(`package.json ${field}.hachure — depend on @kontourai/surface, not hachure directly`);
    }
  }
}

if (violations.length) {
  console.error("[check-hachure-boundary] FAILED — new direct-hachure usage (products speak the open format through Surface):");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nSee the Portfolio Layer Doctrine (surface/docs/architecture/portfolio-layer-doctrine.md).\n" +
      "Use @kontourai/surface (validateTrustBundle / validateInquiryRecord / TrustBundleBuilder).\n" +
      "If this is a deliberate, reviewed exception, add it to the allowlist in this script with a migration note.",
  );
  process.exitCode = 1;
} else {
  const notes = [];
  if (ALLOWLISTED_SOURCE_FILES.size) notes.push(`${ALLOWLISTED_SOURCE_FILES.size} allowlisted source file(s) pending migration`);
  if (pkgDeclaresHachure && ALLOW_PACKAGE_JSON_HACHURE_DEP) notes.push("package.json hachure dep allowlisted pending migration");
  console.log(`[check-hachure-boundary] OK — no new direct-hachure usage${notes.length ? ` (${notes.join("; ")})` : ""}.`);
}
