/**
 * Temporary injection seam for Ferry's importObservations API. The host owns
 * source bytes and commits the returned cursor after replay-safe downstream
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
export function ingestObservationSources(sources, saved, seen, toResidue, { isolateFailures = false } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new Error('observation sources must be a bounded array');
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid observation cursors');
  const cursors = { ...saved }; const batches = []; const blocked = []; const sourceKeys = new Set(); let totalEvents = 0;
  for (const source of sources) {
    if (!source || typeof source.sourceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(source.sourceId) || sourceKeys.has(source.sourceId) || typeof source.data !== 'string' || Buffer.byteLength(source.data) > 64 * 1024 * 1024) throw new Error('invalid observation source');
    if (!Object.hasOwn(source, 'project') || (source.project !== null && (typeof source.project !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(source.project)))) throw new Error('observation source needs an explicit project or global binding');
    sourceKeys.add(source.sourceId);
  }
  for (const source of sources) {
    try {
    const key = `source:${source.sourceId}`;
    const savedSource = Object.hasOwn(saved, key) ? saved[key] : undefined;
    if (savedSource?.version === 1 && savedSource.sourceId === source.sourceId) throw Object.assign(new Error('earlier draft cursor needs scope reconciliation'), { code: 'OBSERVATION_CURSOR_LEGACY' });
    if (savedSource !== undefined && (!savedSource || typeof savedSource !== 'object' || !Object.hasOwn(savedSource, 'project') || savedSource.project !== source.project)) throw Object.assign(new Error('observation scope changed; reconcile the source before retrying'), { code: 'OBSERVATION_SCOPE_CHANGED' });
    const old = savedSource?.cursor;
    if (savedSource !== undefined && (!old || typeof old !== 'object' || old.version !== 1 || old.sourceId !== source.sourceId || !Number.isSafeInteger(old.lines) || old.lines < 0 || !/^[a-f0-9]{64}$/.test(old.digest ?? ''))) throw new Error('invalid observation cursor');
    const result = importObservationSource(source.importer, source.data, { sourceId: source.sourceId, maxMalformed: 0, ...(old ? { cursor: old } : {}) });
    if (!result || !Array.isArray(result.events) || result.events.length > 100000 || !result.cursor || result.cursor.version !== 1 || result.cursor.sourceId !== source.sourceId || !Number.isSafeInteger(result.cursor.lines) || result.cursor.lines < 0 || !/^[a-f0-9]{64}$/.test(result.cursor.digest ?? '') || (old && result.cursor.lines < old.lines) || !Number.isSafeInteger(result.malformed) || result.malformed !== 0 || ![0, 1].includes(result.partial)) throw new Error('observation import was incomplete or invalid');
    const nextTotal = totalEvents + result.events.length;
    if (nextTotal > 100000) throw new Error('observation batch exceeds the event limit');
    const residues = []; const ids = new Set(); let lastOrdinal = old?.lines ?? 0;
    let projectIdentity = savedSource && Object.hasOwn(savedSource, 'projectIdentity') ? savedSource.projectIdentity : undefined;
    if (projectIdentity !== undefined && projectIdentity !== null && (typeof projectIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(projectIdentity))) throw new Error('invalid observation project identity');
    for (const event of result.events) {
      if (!Number.isSafeInteger(event.ordinal) || event.ordinal <= lastOrdinal || event.ordinal > result.cursor.lines) throw new Error('invalid observation event order');
      lastOrdinal = event.ordinal;
      if (event.sourceId !== source.sourceId) throw new Error('observation source identity mismatch');
      const residue = toResidue(event, source.project);
      const observedProject = residue.provenance.projectId;
      if (projectIdentity === undefined || projectIdentity === null) projectIdentity = observedProject;
      else if (observedProject !== null && projectIdentity !== observedProject) throw Object.assign(new Error('observation project identity changed; reconcile the source'), { code: 'OBSERVATION_PROJECT_CHANGED' });
      if (ids.has(residue.sittingId)) throw new Error('duplicate observation event'); ids.add(residue.sittingId);
      if (Object.hasOwn(seen, residue.sittingId)) { if (seen[residue.sittingId] !== residue.contentHash) throw new Error('previously processed observation changed'); }
      else residues.push(residue);
    }
    const nextCursor = { version: 1, sourceId: source.sourceId, lines: result.cursor.lines, digest: result.cursor.digest };
    totalEvents = nextTotal;
    batches.push({ key, cursor: { project: source.project, ...(projectIdentity === undefined ? {} : { projectIdentity }), cursor: nextCursor }, partial: result.partial, residues, eventIds: [...ids] });
    } catch (error) {
      if (!isolateFailures) throw error;
      const known = ['OBSERVATION_CURSOR_LEGACY', 'OBSERVATION_SCOPE_CHANGED', 'OBSERVATION_PROJECT_CHANGED'];
      blocked.push({ sourceId: source.sourceId, reason: known.includes(error?.code) ? error.code : 'OBSERVATION_SOURCE_BLOCKED' });
    }
  }
  return { cursors, batches, blocked };
}
