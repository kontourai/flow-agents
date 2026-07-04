/**
 * Connection + selection for the neo4j knowledge-store provider.
 *
 * Credentials are resolved BY REFERENCE, never hardcoded: the standard
 * neo4j-driver environment variables NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD.
 * (This repo does not yet consume @kontourai/datum — PR #365's model-routing
 * adoption stayed config-file based — so we follow the existing env-reference
 * precedent rather than inventing a datum coupling. If/when datum lands, resolve
 * these three names through it without touching call sites.)
 *
 * The driver is a LAZY, OPTIONAL dependency: neo4j-driver is an
 * optionalDependency, imported on first use inside a try/catch. A missing module
 * OR an unreachable server both degrade to the file providers (AC4) — the graph
 * is never a hard dependency of any repo or workflow.
 *
 * @module providers/neo4j/connection
 */

/**
 * Resolve connection config by reference. Returns { uri, user, password,
 * database } or null when NEO4J_URI is unset (the "no graph configured" signal).
 * @param {object} [env=process.env]
 */
export function resolveNeo4jConfig(env = process.env) {
  const uri = env.NEO4J_URI;
  if (!uri) return null;
  return {
    uri,
    user: env.NEO4J_USER || "neo4j",
    password: env.NEO4J_PASSWORD || "",
    database: env.NEO4J_DATABASE || "neo4j",
  };
}

/**
 * Lazily import neo4j-driver and construct a driver. Returns null if the module
 * is not installed (optional dependency absent) — the caller degrades.
 * @param {object} config from resolveNeo4jConfig
 */
export async function createDriver(config) {
  if (!config) return null;
  let neo4j;
  try {
    neo4j = (await import("neo4j-driver")).default;
  } catch {
    return null; // optional dependency not installed -> degrade
  }
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  // Real (non-fake) driver: the live Cypher analytics backend is available.
  driver.supportsCypherAnalytics = true;
  driver._kgDatabase = config.database;
  return driver;
}

/**
 * Probe whether a Neo4j server is reachable with these credentials. Never
 * throws — returns false on any failure. Used by selectKnowledgeProvider so a
 * down/absent server degrades cleanly instead of erroring.
 * @param {object} driver
 */
export async function isReachable(driver, { timeoutMs = 4000 } = {}) {
  if (!driver) return false;
  try {
    await withTimeout(driver.verifyConnectivity(), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref?.()),
  ]);
}

/**
 * Select the knowledge provider set. The default is the file providers; the
 * neo4j graph is an OPT-IN personal default. Selection is config-driven:
 * `preference` (from repo/user config or KNOWLEDGE_PROVIDER env) chooses neo4j;
 * anything else, or an unreachable/absent Neo4j, falls back to the file
 * providers with a single clear message (AC4).
 *
 * @param {object} options
 * @param {"neo4j"|"file"} [options.preference] explicit preference (default from env)
 * @param {() => object[]|Promise<object[]>} options.fileProviders factory for the file provider set
 * @param {(cfg:object)=>Promise<object>} [options.neo4jFactory] builds the neo4j provider (driver injected)
 * @param {object} [options.env=process.env]
 * @param {(msg:string)=>void} [options.log] one-line status sink (default console.error)
 * @returns {Promise<{ provider:string, providers:object[], graph:object|null, message:string }>}
 */
export async function selectKnowledgeProvider(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((m) => console.error(m));
  const preference = options.preference || env.KNOWLEDGE_PROVIDER || "file";

  const fallback = async (message) => {
    log(message);
    return { provider: "file", providers: await options.fileProviders(), graph: null, message };
  };

  if (preference !== "neo4j") {
    return { provider: "file", providers: await options.fileProviders(), graph: null, message: "" };
  }

  const config = resolveNeo4jConfig(env);
  if (!config) {
    return fallback("knowledge: neo4j selected but NEO4J_URI is unset — using file providers.");
  }
  const driver = options.driver || (await createDriver(config));
  if (!driver) {
    return fallback("knowledge: neo4j-driver not installed — using file providers (run `npm install neo4j-driver`).");
  }
  if (!(await isReachable(driver))) {
    await driver.close?.();
    return fallback(`knowledge: no Neo4j reachable at ${config.uri} — using file providers.`);
  }
  const provider = await options.neo4jFactory({ driver, database: config.database });
  return { provider: "neo4j", providers: [provider], graph: provider, message: `knowledge: neo4j provider selected (${config.uri}).` };
}
