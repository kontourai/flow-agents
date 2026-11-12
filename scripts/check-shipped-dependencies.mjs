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
 *   3. A bare specifier must name a package in dependencies, peerDependencies or
 *      optionalDependencies. Node builtins are exempt. A self-reference must name an `exports`
 *      subpath, because that is all Node resolves for it.
 *
 * Exemptions are per (path prefix, package) with a stated reason; an empty reason is refused.
 *
 * Not covered: non-literal dynamic imports (`import(variable)`), and node code embedded in shell
 * heredocs or other non-JS files. Both are invisible to a parser.
 *
 * Not covered either: `require.resolve(…)`, and `require` obtained from `createRequire`; esbuild
 * reports neither as an import edge.
 *
 * Usage: node scripts/check-shipped-dependencies.mjs [--root <package dir>]
 * Exit 0 when clean, 1 on any undeclared import or precondition failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
  "kits/knowledge/promote/store-target.corpus.test.js": {
    "@kontourai/corpus-store": "Repository test (run by evals/static/test_knowledge_providers.sh against a dev install); store-target.js itself references the package only in JSDoc types.",
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
  const edges = await collectImports(root, scanned);

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

  const lines = [];
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
  return { ok: violations.length === 0, report: lines.join("\n"), violations };
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
