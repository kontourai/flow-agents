import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Relocate an upstream validator's entry-relative schema assets, preserving its
 * own declared dependency graph. This is packaging, not a product-format import.
 * Never substitute the host's direct dependency for the owner's resolved one. */
export function relocatePackageAssets(source: string, ownerEntry: string, vendorDirectory: string): string {
  const lookups = [...source.matchAll(/dirname\(_require\.resolve\("([^"\n]+)"\)\)/g)];
  if (lookups.length !== 1) throw new Error("Package asset lookup seam changed: expected exactly one entry-relative lookup");
  const [lookup, dependency] = lookups[0];
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(dependency)) throw new Error("Unsafe package asset dependency");
  function packageRoot(entry: string): string {
    let directory = path.dirname(entry);
    while (!fs.existsSync(path.join(directory, "package.json"))) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Package metadata missing: ${entry}`);
      directory = parent;
    }
    return directory;
  }
  const ownerRoot = packageRoot(ownerEntry);
  const owner = JSON.parse(fs.readFileSync(path.join(ownerRoot, "package.json"), "utf8"));
  if (!Object.hasOwn(owner.dependencies ?? {}, dependency)) throw new Error(`Undeclared package asset dependency: ${dependency}`);
  const dependencyEntry = createRequire(ownerEntry).resolve(dependency);
  const dependencyRoot = packageRoot(dependencyEntry);
  const metadata = JSON.parse(fs.readFileSync(path.join(dependencyRoot, "package.json"), "utf8"));
  if (metadata.name !== dependency || !metadata.version) throw new Error(`Package asset identity mismatch: ${dependency}`);
  const schemas = path.join(path.dirname(dependencyEntry), "schemas");
  if (!fs.readdirSync(schemas).some(file => file.endsWith(".schema.json"))) throw new Error(`Package schema assets missing: ${dependency}`);
  const notices = fs.readdirSync(dependencyRoot).filter(file => /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(file) && fs.statSync(path.join(dependencyRoot, file)).isFile()).sort();
  if (!notices.length && !metadata.license) throw new Error(`Package asset license metadata missing: ${dependency}`);
  const destination = path.join(vendorDirectory, dependency);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(dependencyRoot, "package.json"), path.join(destination, "package.json"));
  for (const notice of notices) fs.copyFileSync(path.join(dependencyRoot, notice), path.join(destination, notice));
  fs.cpSync(schemas, path.join(destination, "schemas"), { recursive: true });
  const files: { path: string; sha256: string }[] = [];
  function inventory(directory: string): void {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) inventory(file);
      else files.push({ path: path.relative(destination, file).replaceAll(path.sep, "/"), sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
    }
  }
  inventory(destination);
  fs.writeFileSync(path.join(destination, "assets.bundle.json"), JSON.stringify({
    schema_version: "1.0", owner_package: owner.name, owner_version: owner.version,
    package: metadata.name, version: metadata.version, files,
  }, null, 2) + "\n");
  return source.replace(lookup, `fileURLToPath(new URL(${JSON.stringify(`./${dependency}/`)}, import.meta.url))`);
}
