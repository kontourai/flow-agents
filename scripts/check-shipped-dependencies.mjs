#!/usr/bin/env node
/**
 * check-shipped-dependencies — every package a shipped file imports must be installable by a consumer.
 *
 * `@kontourai/flow-agents@9.14.0` shipped kits/knowledge/dream/model.js, which lazily imports
 * `@kontourai/traverse/anthropic`, while Traverse was only a devDependency. The repo's own tests
 * passed (devDependencies are installed here), and every non-dry dream run in a clean consumer
 * install failed with ERR_MODULE_NOT_FOUND. This check closes that class:
 *
 *   1. The shipped file set comes from `npm pack --dry-run --json --ignore-scripts`, i.e. what npm
 *      would actually publish under the `files` field, not a hand-kept list of directories.
 *   2. Every shipped .js/.mjs/.cjs/.ts (not .d.ts) file is parsed by esbuild, and every import
 *      edge it reports (static import/export-from, dynamic `import("…")`, `require`) is
 *      collected. Parsing, not regex, so prose and JSDoc type references
 *      never count and string-literal dynamic imports always do.
 *   3. esbuild does not report `require.resolve("…")` or calls through a `require` made by
 *      `createRequire`, so a second pass matches those shapes in each file's esbuild-transformed
 *      text (comments already stripped): `require.resolve("x")`, `createRequire(…)("x")`,
 *      `createRequire(…).resolve("x")`, and `r("x")` / `r.resolve("x")` where
 *      `const r = createRequire(…)`.
 *   4. A bare specifier must name a package in dependencies, peerDependencies or
 *      optionalDependencies. Node builtins are exempt. A self-reference must name an `exports`
 *      subpath, because that is all Node resolves for it.
 *   5. Test files are excluded from the package by `files` negations, so every asset a shipped
 *      kit.json declares (a kit eval may be a *.test.js file) must still be in the pack.
 *
 * Exemptions are per (path prefix, package) with a stated reason; an empty reason is refused.
 *
 * Not covered: non-literal specifiers (`import(variable)`, `require(variable)`), a created
 * `require` passed around under another name, and node code embedded in shell heredocs or other
 * non-JS files.
 *
 * Usage: node scripts/check-shipped-dependencies.mjs [--root <package dir>]
 * Exit 0 when clean, 1 on any undeclared import or precondition failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

// Shipped paths whose imports are deliberately not satisfied by this package's manifest.
// Key: path prefix (posix, relative to the package root). Value: package name -> reason.
// A package of "*" covers every import under the prefix.
const EXEMPTIONS = {
  "integrations/strands-ts/": {
    "*": "Source of the separately published @kontourai/flow-agents-strands package; its imports are declared in integrations/strands-ts/package.json. The shipped copy has no built dist/, so nothing in this package can load it.",
  },
  "scripts/ci/": {
    yaml: "This repository's own CI compute-policy tooling, run only by its workflows and evals/ci tests against a dev install; no shipped runtime path or bin invokes scripts/ci/.",
  },
  "scripts/build-knowledge-yaml.mjs": {
    yaml: "Build-time generator run by `npm run build` in this repository; it deliberately resolves the exact devDependency pin and writes the self-contained adapter the kit ships.",
  },
};

const SCANNED = /\.(?:[cm]?js|[cm]?ts)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const IMPORT_KINDS = new Set(["import-statement", "dynamic-import", "require-call"]);

export function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isBuiltin(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(packageNameOf(specifier));
}

function isBare(specifier) {
  return !(specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith("node:"));
}

export function packedFiles(root) {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
    throw new Error(`unexpected npm pack --dry-run --json output shape in ${root}`);
  }
  return parsed[0].files.map((entry) => entry.path);
}

// Entry points named by the manifest must be in the pack; otherwise the scan would silently cover
// a partial tree (for example, build/ not generated yet).
function manifestTargets(pkg) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === "string" && !value.includes("*")) targets.add(value.replace(/^\.\//, ""));
    else if (value && typeof value === "object") Object.values(value).forEach(add);
  };
  add(pkg.main);
  add(pkg.bin);
  add(pkg.exports);
  targets.delete("package.json");
  return [...targets];
}

function exportSubpaths(pkg) {
  if (!pkg.exports || typeof pkg.exports !== "object") return null;
  return Object.keys(pkg.exports);
}

function selfReferenceResolves(specifier, pkg) {
  const subpaths = exportSubpaths(pkg);
  if (!subpaths) return true;
  const sub = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
  return subpaths.some((key) => {
    if (!key.includes("*")) return key === sub;
    const [before, after] = key.split("*");
    return sub.startsWith(before) && sub.endsWith(after) && sub.length >= before.length + after.length;
  });
}

function exemptionFor(file, name) {
  for (const [prefix, packages] of Object.entries(EXEMPTIONS)) {
    if (!file.startsWith(prefix)) continue;
    const reason = packages[name] ?? packages["*"];
    if (reason !== undefined) return { prefix, reason };
  }
  return null;
}

export async function collectImports(root, files) {
  const edges = [];
  const fail = (errors) => new Error(`esbuild could not parse shipped files:\n${errors.map((e) => `  ${e.location?.file ?? "?"}:${e.location?.line ?? "?"}: ${e.text}`).join("\n")}`);
  let result;
  try {
    result = await build({
    absWorkingDir: root,
    entryPoints: files,
    bundle: true,
    write: false,
    outdir: path.join(root, ".shipped-dependencies-scan"),
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [{
      name: "collect-imports",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return undefined;
          if (IMPORT_KINDS.has(args.kind)) {
            edges.push({ file: path.relative(root, args.importer).split(path.sep).join("/"), specifier: args.path, kind: args.kind });
          }
          return { path: args.path, external: true };
        });
      },
    }],
    });
  } catch (error) {
    if (Array.isArray(error?.errors)) throw fail(error.errors);
    throw error;
  }
  if (result.errors.length > 0) throw fail(result.errors);
  return edges;
}

// Kit asset classes come from the installer's own reader (src/runtime-adapters.ts, compiled), so
// this check and kit installation cannot disagree about what a kit declares. The compiled module
// must exist; the CI command builds before running this script.
async function kitAssetClasses() {
  const compiled = new URL("../build/src/runtime-adapters.js", import.meta.url);
  try {
    const { ASSET_CLASSES } = await import(compiled.href);
    if (!Array.isArray(ASSET_CLASSES) || ASSET_CLASSES.length === 0) throw new Error("ASSET_CLASSES is not a non-empty array");
    return ASSET_CLASSES;
  } catch (error) {
    throw new Error(`cannot load kit asset classes from ${fileURLToPath(compiled)} (run \`npm run build\` first): ${error.message}`);
  }
}

function missingKitAssets(root, files, fileSet, KIT_ASSET_CLASSES) {
  const missing = [];
  for (const manifest of files.filter((file) => /^kits\/[^/]+\/kit\.json$/.test(file))) {
    const kitDir = path.posix.dirname(manifest);
    const kit = JSON.parse(readFileSync(path.join(root, manifest), "utf8"));
    for (const assetClass of KIT_ASSET_CLASSES) {
      for (const entry of Array.isArray(kit[assetClass]) ? kit[assetClass] : []) {
        const rel = typeof entry === "string" ? entry : entry?.path;
        if (typeof rel !== "string") continue;
        const target = path.posix.normalize(path.posix.join(kitDir, rel));
        if (!fileSet.has(target) && !files.some((file) => file.startsWith(`${target}/`))) missing.push(`${assetClass} ${target}`);
      }
    }
  }
  return missing;
}

// A single string-literal argument; named groups so it composes into larger patterns.
const STRING = String.raw`\s*(?<q>["'\x60])(?<spec>[^"'\x60\n]+)\k<q>\s*\)`;

// Edges esbuild does not report: require.resolve and calls through a createRequire result.
export async function collectResolveEdges(root, files) {
  const edges = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    if (!/\bresolve\s*\(|createRequire/.test(source)) continue;
    const loader = /\.[cm]?ts$/.test(file) ? "ts" : "js";
    const { code } = await transform(source, { loader, sourcefile: file, legalComments: "none" });
    const add = (kind, specifier) => {
      if (!specifier.includes("${")) edges.push({ file, specifier, kind });
    };
    for (const m of code.matchAll(new RegExp(String.raw`\brequire\.resolve\(${STRING}`, "g"))) add("require-resolve", m.groups.spec);
    // createRequire under its own name or an alias (`import { createRequire as cr }`,
    // `const { createRequire: cr } = …`).
    const factories = new Set(["createRequire"]);
    for (const m of code.matchAll(/\bcreateRequire\s*(?:as\s+|:\s*)([A-Za-z_$][\w$]*)/g)) factories.add(m[1]);
    const factory = String.raw`(?<![\w$])(?:[\w$]+\.)?(?:${[...factories].map((name) => name.replace(/\$/g, "\\$")).join("|")})`;
    for (const m of code.matchAll(new RegExp(String.raw`${factory}\([^()]*(?:\([^()]*\)[^()]*)*\)(?<res>\.resolve)?\(${STRING}`, "g"))) add(m.groups.res ? "created-require-resolve" : "created-require-call", m.groups.spec);
    const names = [...code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${factory}\s*\(`, "g"))].map((m) => m[1]);
    for (const name of new Set(names)) {
      if (name === "require") continue; // handled below
      const escaped = name.replace(/\$/g, "\\$");
      for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${escaped}(?<res>\.resolve)?\(${STRING}`, "g"))) add(m.groups.res ? "created-require-resolve" : "created-require-call", m.groups.spec);
    }
    if (names.includes("require")) {
      // `const require = createRequire(...)` shadows the global, so esbuild reports no edge for require("x").
      for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])require\(${STRING}`, "g"))) add("created-require-call", m.groups.spec);
    }
  }
  return edges;
}

export async function checkShippedDependencies(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const files = packedFiles(root);
  const fileSet = new Set(files);
  const missingTargets = manifestTargets(pkg).filter((target) => !fileSet.has(target));
  if (missingTargets.length > 0) {
    return {
      ok: false,
      report: [
        "shipped-dependencies: the packed file list is missing manifest entry points, so the scan would be partial.",
        ...missingTargets.slice(0, 10).map((target) => `  missing: ${target}`),
        "  Run `npm run build` first.",
      ].join("\n"),
    };
  }
  for (const [prefix, packages] of Object.entries(EXEMPTIONS)) {
    for (const [name, reason] of Object.entries(packages)) {
      if (typeof reason !== "string" || reason.trim() === "") throw new Error(`exemption ${prefix} ${name} has no reason`);
    }
  }

  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const devOnly = new Set(Object.keys(pkg.devDependencies ?? {}).filter((name) => !declared.has(name)));
  const scanned = files.filter((file) => SCANNED.test(file) && !DECLARATION.test(file));
  const edges = [...await collectImports(root, scanned), ...await collectResolveEdges(root, scanned)];

  const violations = [];
  const exempted = new Map();
  for (const edge of edges) {
    const { specifier } = edge;
    if (!isBare(specifier) || isBuiltin(specifier)) continue;
    const name = packageNameOf(specifier);
    if (name === pkg.name) {
      if (!selfReferenceResolves(specifier, pkg)) violations.push({ ...edge, name, why: `self-reference to a subpath not in "exports"` });
      continue;
    }
    if (declared.has(name)) continue;
    const exemption = exemptionFor(edge.file, name);
    if (exemption) {
      exempted.set(`${exemption.prefix} ${name}`, exemption.reason);
      continue;
    }
    violations.push({ ...edge, name, why: devOnly.has(name) ? "only in devDependencies" : "not in package.json" });
  }

  const missingAssets = missingKitAssets(root, files, fileSet, await kitAssetClasses());
  const lines = [];
  if (missingAssets.length > 0) {
    lines.push(`shipped-dependencies: FAIL — ${missingAssets.length} asset(s) declared by a shipped kit.json are not in the pack.`);
    lines.push("A `files` negation (for example the *.test.* exclusions) dropped them; re-include each path in package.json `files`.");
    for (const asset of missingAssets) lines.push(`  ${asset}`);
  }
  if (violations.length === 0) {
    lines.push(`shipped-dependencies: OK — ${scanned.length} shipped source files, ${edges.length} import edges, every bare import is declared.`);
  } else {
    lines.push(`shipped-dependencies: FAIL — ${violations.length} shipped import(s) would not resolve on a clean consumer install.`);
    lines.push("Declare each package in dependencies, peerDependencies or optionalDependencies, or add a reasoned exemption.");
    const byName = new Map();
    for (const violation of violations) {
      if (!byName.has(violation.name)) byName.set(violation.name, []);
      byName.get(violation.name).push(violation);
    }
    for (const [name, list] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${name} (${list[0].why})`);
      for (const v of list) lines.push(`    ${v.file}: ${v.kind} "${v.specifier}"`);
    }
  }
  for (const [key, reason] of exempted) lines.push(`  exempt: ${key} — ${reason}`);
  return { ok: violations.length === 0 && missingAssets.length === 0, report: lines.join("\n"), violations, missingAssets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  // realpath: esbuild reports importers by real path, so a symlinked root (macOS /var -> /private/var)
  // would otherwise turn every reported file into a ../ path.
  const root = realpathSync(path.resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
  try {
    const { ok, report } = await checkShippedDependencies(root);
    (ok ? console.log : console.error)(report);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`shipped-dependencies: ERROR — ${error.message}`);
    process.exit(1);
  }
}
