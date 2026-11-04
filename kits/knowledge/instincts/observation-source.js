/**
 * Temporary injection seam for Ferry's importObservations API. The host owns
 * source bytes and must commit the returned cursor atomically with downstream
 * effects. This shim does not parse files or commit cursors. Replace the
 * injected importer with the published Ferry API after kontourai/thread#80.
 */
export function importObservationSource(importer, data, options) {
  if (typeof importer !== 'function') throw new TypeError('observation importer must be a function');
  if (!options || typeof options.sourceId !== 'string' || !options.sourceId.trim()) throw new TypeError('sourceId must be a non-empty string');
  // Ferry owns parsing, cursor validation, omission limits and replay checks.
  // Copy the options so an adapter cannot mutate the caller's saved cursor.
  return importer(data, structuredClone(options));
}
