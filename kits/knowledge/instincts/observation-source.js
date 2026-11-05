/**
 * Temporary injection seam for Ferry's importObservations API. The host owns
 * source bytes and must commit the returned cursor atomically with downstream
 * effects. This shim does not parse files or commit cursors. Replace the
 * injected importer after the Ferry release containing kontourai/thread#80.
 */
export function importObservationSource(importer, data, options) {
  if (typeof importer !== 'function') throw new TypeError('observation importer must be a function');
  if (!options || typeof options.sourceId !== 'string' || !options.sourceId.trim()) throw new TypeError('sourceId must be a non-empty string');
  // Ferry owns parsing, cursor validation, omission limits and replay checks.
  // Copy the options so an adapter cannot mutate the caller's saved cursor.
  return importer(data, structuredClone(options));
}

/** Read host-provided sources using Ferry's replay cursors; never write cursors here. */
export function ingestObservationSources(sources, saved, seen, toResidue) {
  if (!Array.isArray(sources) || sources.length > 32) throw new Error('observation sources must be a bounded array');
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid observation cursors');
  const cursors = { ...saved }; const batches = []; const sourceKeys = new Set();
  for (const source of sources) {
    if (!source || typeof source.sourceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(source.sourceId) || sourceKeys.has(source.sourceId) || typeof source.data !== 'string' || Buffer.byteLength(source.data) > 64 * 1024 * 1024) throw new Error('invalid observation source');
    sourceKeys.add(source.sourceId);
    const key = `source:${source.sourceId}`;
    const old = Object.hasOwn(saved, key) ? saved[key] : undefined;
    if (old !== undefined && (!old || typeof old !== 'object' || old.version !== 1 || old.sourceId !== source.sourceId || !Number.isSafeInteger(old.lines) || old.lines < 0 || !/^[a-f0-9]{64}$/.test(old.digest ?? ''))) throw new Error('invalid observation cursor');
    const result = importObservationSource(source.importer, source.data, { sourceId: source.sourceId, ...(old ? { cursor: old } : {}) });
    if (!result || !Array.isArray(result.events) || result.events.length > 100000 || !result.cursor || result.cursor.version !== 1 || result.cursor.sourceId !== source.sourceId || !Number.isSafeInteger(result.cursor.lines) || result.cursor.lines < 0 || !/^[a-f0-9]{64}$/.test(result.cursor.digest ?? '') || (old && result.cursor.lines < old.lines) || !Number.isSafeInteger(result.malformed) || result.malformed !== 0 || ![0, 1].includes(result.partial)) throw new Error('observation import was incomplete or invalid');
    const residues = []; const ids = new Set(); let lastOrdinal = old?.lines ?? 0;
    for (const event of result.events) {
      if (!Number.isSafeInteger(event.ordinal) || event.ordinal <= lastOrdinal || event.ordinal > result.cursor.lines) throw new Error('invalid observation event order');
      lastOrdinal = event.ordinal;
      if (event.sourceId !== source.sourceId) throw new Error('observation source identity mismatch');
      const residue = toResidue(event); if (ids.has(residue.sittingId)) throw new Error('duplicate observation event'); ids.add(residue.sittingId);
      if (Object.hasOwn(seen, residue.sittingId)) { if (seen[residue.sittingId] !== residue.contentHash) throw new Error('previously processed observation changed'); }
      else residues.push(residue);
    }
    batches.push({ key, cursor: result.cursor, residues });
  }
  return { cursors, batches };
}
