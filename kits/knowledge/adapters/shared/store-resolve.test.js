/**
 * Global personal-store bootstrap and roots-registry contract (WI-2 / AC4-R5).
 *
 * This suite deliberately uses an explicit, private HOME and XDG_DATA_HOME for
 * every write.  It must never exercise a developer's ambient knowledge store.
 *
 * Run: node --test kits/knowledge/adapters/shared/store-resolve.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PERSONAL_ROOT_NAME,
  ensureGlobalStore,
  globalStoreLocation,
  loadRoots,
  nameForRoot,
  resolveRoot,
  rootsRegistryPath,
  saveRoots,
} from "./store-resolve.js";
import { emptyAliasIndex, emptyGraph } from "./codec.js";

function privateEnv(tag) {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `store-resolve-${tag}-`));
  const home = path.join(fixture, "home");
  const xdg = path.join(fixture, "xdg");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  return { fixture, env: { HOME: home, XDG_DATA_HOME: xdg } };
}

function cleanup(t, fixture) {
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertContained(child, parent, message) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), message);
}

function permissionBits(file) {
  return fs.statSync(file).mode & 0o777;
}

function seedStore(storeRoot) {
  fs.mkdirSync(path.join(storeRoot, "records"), { recursive: true });
  fs.writeFileSync(path.join(storeRoot, "graph-index.json"), JSON.stringify(emptyGraph(), null, 2) + "\n");
  fs.writeFileSync(path.join(storeRoot, "alias-index.json"), JSON.stringify(emptyAliasIndex(), null, 2) + "\n");
  fs.writeFileSync(path.join(storeRoot, "records", ".gitkeep"), "");
}

describe("global personal store bootstrap", () => {
  test("uses the XDG data location, scaffolds the canonical empty-store shape, and registers personal", (t) => {
    const { fixture, env } = privateEnv("bootstrap");
    cleanup(t, fixture);

    const location = globalStoreLocation(env);
    assert.equal(location.repoRoot, path.join(env.XDG_DATA_HOME, "knowledge-store"));
    assert.equal(location.storeRoot, path.join(location.repoRoot, "knowledge"));
    assertContained(location.repoRoot, env.XDG_DATA_HOME, "global repository must stay below the private XDG root");

    const storeRoot = ensureGlobalStore(env);
    assert.equal(storeRoot, location.storeRoot);
    assertContained(storeRoot, fixture, "bootstrap must never resolve into the real user home");
    assert.deepEqual(readJson(path.join(storeRoot, "graph-index.json")), emptyGraph());
    assert.deepEqual(readJson(path.join(storeRoot, "alias-index.json")), emptyAliasIndex());
    assert.ok(fs.existsSync(path.join(storeRoot, "records", ".gitkeep")), "empty records directory is retained");

    const registryFile = rootsRegistryPath(env);
    assert.equal(registryFile, path.join(env.XDG_DATA_HOME, "knowledge-store", "roots.json"));
    assert.deepEqual(readJson(registryFile), { roots: { personal: storeRoot } }, "registry stays MCP-compatible");
    assert.equal(permissionBits(location.repoRoot), 0o700, "global repository metadata is private");
    assert.equal(permissionBits(storeRoot), 0o700, "personal store is private");
    assert.equal(permissionBits(path.join(storeRoot, "records")), 0o700, "record directory is private");
    assert.equal(permissionBits(registryFile), 0o600, "roots registry is private");
    assert.equal(loadRoots(env).roots.personal, storeRoot);
    assert.equal(resolveRoot(PERSONAL_ROOT_NAME, env), storeRoot, "reserved name resolves to the scaffolded store");
    assert.equal(nameForRoot(storeRoot, env), PERSONAL_ROOT_NAME, "reverse lookup reports the reserved root name");
  });

  test("falls back to HOME/.local/share only when XDG_DATA_HOME is absent", (t) => {
    const { fixture, env } = privateEnv("home-fallback");
    cleanup(t, fixture);
    delete env.XDG_DATA_HOME;

    const location = globalStoreLocation(env);
    assert.equal(location.repoRoot, path.join(env.HOME, ".local", "share", "knowledge-store"));
    assert.equal(ensureGlobalStore(env), location.storeRoot);
    assertContained(location.storeRoot, env.HOME, "HOME fallback must remain under the private HOME");
  });

  test("is idempotent and byte-stable while preserving unrelated roots and default_write", (t) => {
    const { fixture, env } = privateEnv("idempotent");
    cleanup(t, fixture);
    const location = globalStoreLocation(env);
    const externalRoot = path.join(fixture, "external-store");
    seedStore(externalRoot);
    fs.mkdirSync(location.repoRoot, { recursive: true });
    fs.writeFileSync(
      rootsRegistryPath(env),
      JSON.stringify({ roots: { zebra: externalRoot, alpha: externalRoot }, default_write: "zebra" }, null, 2) + "\n",
    );

    const first = ensureGlobalStore(env);
    const firstRegistry = fs.readFileSync(rootsRegistryPath(env), "utf8");
    fs.chmodSync(rootsRegistryPath(env), 0o644);
    fs.chmodSync(location.storeRoot, 0o755);
    fs.chmodSync(path.join(location.storeRoot, "records"), 0o755);
    fs.chmodSync(path.join(location.storeRoot, "graph-index.json"), 0o644);
    const second = ensureGlobalStore(env);
    const secondRegistry = fs.readFileSync(rootsRegistryPath(env), "utf8");

    assert.equal(first, location.storeRoot);
    assert.equal(second, first);
    assert.equal(secondRegistry, firstRegistry, "retries must not rewrite a settled registry");
    assert.deepEqual(readJson(rootsRegistryPath(env)), {
      roots: { alpha: externalRoot, personal: location.storeRoot, zebra: externalRoot },
      default_write: "zebra",
    }, "writes sort root names and preserve existing registry fields");
    assert.equal(permissionBits(rootsRegistryPath(env)), 0o600, "idempotent reuse tightens registry permissions");
    assert.equal(permissionBits(location.storeRoot), 0o700, "idempotent reuse tightens store permissions");
    assert.equal(permissionBits(path.join(location.storeRoot, "records")), 0o700, "idempotent reuse tightens record permissions");
    assert.equal(permissionBits(path.join(location.storeRoot, "graph-index.json")), 0o600, "idempotent reuse tightens index permissions");
  });
});

describe("roots registry safety and resolution", () => {
  test("preserves the existing registry if an atomic replacement fails and leaves no temporary sibling", (t) => {
    const { fixture, env } = privateEnv("atomic-failure");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const before = JSON.stringify({ roots: { alpha: "/tmp/alpha" }, default_write: "alpha" }, null, 2) + "\n";
    fs.writeFileSync(registryFile, before);
    const failingFs = {
      ...fs,
      renameSync() {
        throw new Error("injected atomic rename failure");
      },
    };

    assert.throws(
      () => saveRoots({ roots: { alpha: "/tmp/alpha", beta: "/tmp/beta" }, default_write: "alpha" }, env, { fs: failingFs }),
      /injected atomic rename failure/,
      "persistence failures must be reported to the caller",
    );
    assert.equal(fs.readFileSync(registryFile, "utf8"), before, "failed replacement must not tear or overwrite the old registry");
    assert.deepEqual(fs.readdirSync(path.dirname(registryFile)).sort(), ["roots.json"], "failed replacement must clean its temporary sibling");
  });

  test("refuses malformed registries rather than treating them as empty and overwriting them", (t) => {
    const { fixture, env } = privateEnv("malformed");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const malformed = "{ definitely-not-json\n";
    fs.writeFileSync(registryFile, malformed);

    assert.throws(() => ensureGlobalStore(env), /roots\.json|registry|JSON|malformed/i);
    assert.equal(fs.readFileSync(registryFile, "utf8"), malformed, "malformed registry must remain untouched for repair");
  });

  test("refuses a pre-existing personal registration that escapes the configured global store", (t) => {
    const { fixture, env } = privateEnv("uncontained-personal");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    const escaped = path.join(fixture, "outside", "knowledge");
    seedStore(escaped);
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const registry = { roots: { personal: escaped } };
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");

    assert.throws(() => ensureGlobalStore(env), /personal|contain|global|root/i);
    assert.deepEqual(readJson(registryFile), registry, "bootstrap must not silently repoint a conflicting personal root");
  });

  test("refuses symlinked XDG ancestry before creating a store outside the private fixture", { skip: process.platform === "win32" }, (t) => {
    const { fixture, env } = privateEnv("symlink");
    cleanup(t, fixture);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "store-resolve-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const symlink = path.join(fixture, "xdg-link");
    fs.symlinkSync(outside, symlink, "dir");
    env.XDG_DATA_HOME = symlink;

    assert.throws(() => ensureGlobalStore(env), /symlink|contain|XDG/i);
    assert.ok(!fs.existsSync(path.join(outside, "knowledge-store")), "refusal must happen before any write follows the symlink");
  });

  test("refuses a symlinked parent above XDG_DATA_HOME", { skip: process.platform === "win32" }, (t) => {
    const { fixture, env } = privateEnv("parent-symlink");
    cleanup(t, fixture);
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "store-resolve-parent-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const logicalParent = path.join(fixture, "logical-parent");
    fs.symlinkSync(outside, logicalParent, "dir");
    env.XDG_DATA_HOME = path.join(logicalParent, "xdg");

    assert.throws(() => ensureGlobalStore(env), /symlink ancestry|symlink/i);
    assert.ok(!fs.existsSync(path.join(outside, "xdg", "knowledge-store")), "parent symlink is refused before writes");
  });

  test("fails loud on a concurrent registry lock and preserves the prior roots", (t) => {
    const { fixture, env } = privateEnv("registry-lock");
    cleanup(t, fixture);
    const location = globalStoreLocation(env);
    fs.mkdirSync(location.repoRoot, { recursive: true });
    const registry = { roots: { alpha: path.join(fixture, "alpha") } };
    fs.writeFileSync(rootsRegistryPath(env), `${JSON.stringify(registry, null, 2)}\n`);
    fs.mkdirSync(path.join(location.repoRoot, ".roots.json.lock"));

    assert.throws(() => ensureGlobalStore(env), /locked|another writer/i);
    assert.deepEqual(readJson(rootsRegistryPath(env)), registry, "busy writer must not clobber existing roots");
  });

  test("removes an ownerless lock if owner metadata cannot be persisted", (t) => {
    const { fixture, env } = privateEnv("lock-owner-failure");
    cleanup(t, fixture);
    const location = globalStoreLocation(env);
    const failingFs = {
      ...fs,
      writeFileSync(file, ...args) {
        if (path.basename(file) === "owner.json") throw new Error("injected owner metadata failure");
        return fs.writeFileSync(file, ...args);
      },
    };

    assert.throws(() => ensureGlobalStore(env, { fs: failingFs }), /owner metadata failure/);
    assert.equal(fs.existsSync(path.join(location.repoRoot, ".roots.json.lock")), false, "failed owner metadata must not strand a lock");
  });

  test("merges an uncooperative writer update that lands at the no-clobber install boundary", (t) => {
    const { fixture, env } = privateEnv("registry-interleave");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    const alpha = path.join(fixture, "alpha");
    const external = path.join(fixture, "external");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, `${JSON.stringify({ roots: { alpha }, default_write: "alpha" }, null, 2)}\n`);
    let injected = false;
    const interleavingFs = {
      ...fs,
      linkSync(source, destination) {
        if (!injected && destination === registryFile) {
          injected = true;
          fs.writeFileSync(registryFile, `${JSON.stringify({ roots: { alpha, external_writer: external }, default_write: "external_writer" }, null, 2)}\n`);
        }
        return fs.linkSync(source, destination);
      },
    };

    ensureGlobalStore(env, { fs: interleavingFs });

    assert.equal(injected, true, "fixture must interleave at the old-registry capture boundary");
    assert.deepEqual(readJson(registryFile), {
      roots: { alpha, external_writer: external, personal: globalStoreLocation(env).storeRoot },
      default_write: "external_writer",
    }, "the personal root plus the uncooperative writer's root and default must all survive");
  });

  test("fails closed on a concurrent same-name root conflict and preserves the external value", (t) => {
    const { fixture, env } = privateEnv("registry-conflict");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    const alpha = path.join(fixture, "alpha");
    const conflict = path.join(fixture, "other-personal");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, `${JSON.stringify({ roots: { alpha } }, null, 2)}\n`);
    let injected = false;
    const interleavingFs = {
      ...fs,
      linkSync(source, destination) {
        if (!injected && destination === registryFile) {
          injected = true;
          fs.writeFileSync(registryFile, `${JSON.stringify({ roots: { alpha, personal: conflict } }, null, 2)}\n`);
        }
        return fs.linkSync(source, destination);
      },
    };

    assert.throws(() => ensureGlobalStore(env, { fs: interleavingFs }), /concurrent conflict.*personal/i);
    assert.deepEqual(readJson(registryFile), { roots: { alpha, personal: conflict } }, "conflicting external value remains authoritative for repair");
  });

  test("recovers a captured registry before a reader can treat it as empty", (t) => {
    const { fixture, env } = privateEnv("captured-recovery");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    const registry = { roots: { alpha: path.join(fixture, "alpha") }, default_write: "alpha" };
    const captured = path.join(path.dirname(registryFile), `.roots.json.${process.pid}.crash.captured`);
    const lock = path.join(path.dirname(registryFile), ".roots.json.lock");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
    fs.renameSync(registryFile, captured);
    fs.mkdirSync(lock);

    assert.deepEqual(loadRoots(env), registry, "reader recovers the last complete captured registry");
    assert.deepEqual(readJson(registryFile), registry, "recovery restores the canonical discovery path");
    assert.equal(fs.existsSync(captured), false, "recovered capture is retired after no-clobber installation");
    assert.equal(fs.existsSync(lock), true, "stale writer lock remains fail-closed for manual PID-checked repair");
  });

  test("returns a complete capture when the active writer retires it during the read", (t) => {
    const { fixture, env } = privateEnv("capture-retirement-race");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    const alpha = path.join(fixture, "alpha");
    const beta = path.join(fixture, "beta");
    const captured = path.join(path.dirname(registryFile), `.roots.json.${process.pid}.active.captured`);
    const lock = path.join(path.dirname(registryFile), ".roots.json.lock");
    const owner = path.join(lock, "owner.json");
    const before = { roots: { alpha }, default_write: "alpha" };
    const after = { roots: { alpha, beta }, default_write: "beta" };
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(owner, `${JSON.stringify({ pid: process.pid })}\n`);
    fs.writeFileSync(captured, `${JSON.stringify(before, null, 2)}\n`);
    let retired = false;
    const racingFs = {
      ...fs,
      readFileSync(file, ...args) {
        const content = fs.readFileSync(file, ...args);
        if (!retired && file === captured) {
          retired = true;
          fs.writeFileSync(registryFile, `${JSON.stringify(after, null, 2)}\n`);
          fs.unlinkSync(captured);
        }
        return content;
      },
    };

    assert.deepEqual(loadRoots(env, { fs: racingFs }), before, "reader returns the already parsed complete capture, never an empty registry");
    assert.deepEqual(readJson(registryFile), after, "the active writer's installed canonical registry remains untouched");
  });

  test("retries capture discovery when a writer starts capture after canonical existence is observed", (t) => {
    const { fixture, env } = privateEnv("capture-start-race");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    const registry = { roots: { alpha: path.join(fixture, "alpha") }, default_write: "alpha" };
    const captured = path.join(path.dirname(registryFile), `.roots.json.${process.pid}.starting.captured`);
    const lock = path.join(path.dirname(registryFile), ".roots.json.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
    let started = false;
    const racingFs = {
      ...fs,
      lstatSync(file) {
        const stat = fs.lstatSync(file);
        if (!started && file === registryFile) {
          started = true;
          fs.renameSync(registryFile, captured);
        }
        return stat;
      },
    };

    assert.deepEqual(loadRoots(env, { fs: racingFs }), registry, "canonical ENOENT retries the already-started complete capture");
    assert.equal(fs.existsSync(captured), true, "active writer capture remains available to its owner");
  });

  test("retries when canonical appears after an empty capture scan and is immediately recaptured", (t) => {
    const { fixture, env } = privateEnv("capture-fallback-race");
    cleanup(t, fixture);
    const registryFile = rootsRegistryPath(env);
    const registry = { roots: { alpha: path.join(fixture, "alpha") }, default_write: "alpha" };
    const captured = path.join(path.dirname(registryFile), `.roots.json.${process.pid}.fallback.captured`);
    const lock = path.join(path.dirname(registryFile), ".roots.json.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
    let installed = false;
    let recaptured = false;
    const racingFs = {
      ...fs,
      readdirSync(directory, ...args) {
        const entries = fs.readdirSync(directory, ...args);
        if (!installed && directory === path.dirname(registryFile)) {
          installed = true;
          fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
        }
        return entries;
      },
      lstatSync(file) {
        const stat = fs.lstatSync(file);
        if (installed && !recaptured && file === registryFile) {
          recaptured = true;
          fs.renameSync(registryFile, captured);
        }
        return stat;
      },
    };

    assert.deepEqual(loadRoots(env, { fs: racingFs }), registry, "fallback ENOENT loops to the immediately recaptured complete registry");
    assert.equal(installed, true);
    assert.equal(recaptured, true);
  });

  test("refuses an incomplete existing scaffold instead of repairing it", (t) => {
    const { fixture, env } = privateEnv("incomplete");
    cleanup(t, fixture);
    const { storeRoot } = globalStoreLocation(env);
    fs.mkdirSync(path.join(storeRoot, "records"), { recursive: true });
    fs.writeFileSync(path.join(storeRoot, "graph-index.json"), `${JSON.stringify(emptyGraph())}\n`);

    assert.throws(() => ensureGlobalStore(env), /incomplete|invalid store scaffold/i);
    assert.equal(fs.existsSync(path.join(storeRoot, "alias-index.json")), false, "invalid scaffold remains untouched");
  });

  test("resolves only registered names or valid absolute store roots", (t) => {
    const { fixture, env } = privateEnv("resolve");
    cleanup(t, fixture);
    const location = globalStoreLocation(env);
    const storeRoot = ensureGlobalStore(env);

    assert.equal(resolveRoot("personal", env), storeRoot);
    assert.equal(resolveRoot(storeRoot, env), storeRoot);
    assert.equal(resolveRoot(path.join(location.repoRoot, "not-a-store"), env), null);
    assert.equal(resolveRoot("not-registered", env), null);
  });
});
