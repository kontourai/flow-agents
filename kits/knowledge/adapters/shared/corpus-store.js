/** Select Corpus Store as the sole owner of every store operation.
 * The host supplies the published module and its coordination services. The
 * legacy adapters do not share Corpus's lock or recovery protocol, so the host
 * must first stop legacy readers and writers and, for a kit-v1 vault, use Corpus migration.
 */
export function openCorpusStore(selection, options, exportName) {
  if (selection === undefined) return null;
  if (!selection || selection.legacyProcessesStopped !== true) {
    throw new Error("Corpus Store selection requires legacyProcessesStopped: true");
  }
  const Adapter = selection.module?.[exportName];
  if (typeof Adapter !== "function") throw new Error(`Corpus Store selection requires ${exportName}`);
  if (typeof Adapter.prototype?.purge !== "function") {
    throw new Error("Corpus Store selection requires a package with purge support");
  }
  if (!selection.services || typeof selection.services !== "object") {
    throw new Error("Corpus Store selection requires host coordination services");
  }
  return new Adapter({ ...selection.services, ...options });
}

/** Legacy stores do not have a safe purge implementation. */
export function purgeUnavailable() {
  const error = new Error("purge requires an explicitly selected Corpus Store with host coordination");
  error.code = "READ_ONLY";
  return error;
}
