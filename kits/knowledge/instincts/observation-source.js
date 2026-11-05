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

const sourceError = (code, message) => Object.assign(new Error(message), { code });

/** Read host-provided sources using Ferry's replay cursors; never write cursors here. */
export function ingestObservationSources(sources, saved, seen, toResidue, { isolateFailures = false } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new Error('observation sources must be a bounded array');
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid observation cursors');
  // Snapshot host bindings before any importer can run or mutate another source.
  const inputs = sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('invalid observation source');
    return { sourceId: source.sourceId, project: source.project, projectPresent: Object.hasOwn(source, 'project'), data: source.data, importer: source.importer };
  });
  const cursors = { ...saved }; const batches = []; const blocked = []; const sourceKeys = new Set(); let totalEvents = 0;
  for (const source of inputs) {
    if (!source || typeof source.sourceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(source.sourceId) || sourceKeys.has(source.sourceId) || typeof source.data !== 'string' || Buffer.byteLength(source.data) > 64 * 1024 * 1024) throw new Error('invalid observation source');
    if (!source.projectPresent || (source.project !== null && (typeof source.project !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(source.project)))) throw new Error('observation source needs an explicit project or global binding');
    sourceKeys.add(source.sourceId);
  }
  for (const source of inputs) {
    try {
    const key = `source:${source.sourceId}`;
    const savedSource = Object.hasOwn(saved, key) ? saved[key] : undefined;
    if (savedSource?.version === 1 && savedSource.sourceId === source.sourceId) throw Object.assign(new Error('earlier draft cursor needs scope reconciliation'), { code: 'OBSERVATION_CURSOR_LEGACY' });
    if (savedSource !== undefined && (!savedSource || typeof savedSource !== 'object' || !Object.hasOwn(savedSource, 'project') || savedSource.project !== source.project)) throw Object.assign(new Error('observation scope changed; reconcile the source before retrying'), { code: 'OBSERVATION_SCOPE_CHANGED' });
    const old = savedSource?.cursor;
    if (savedSource !== undefined && (!old || typeof old !== 'object' || old.version !== 1 || old.sourceId !== source.sourceId || !Number.isSafeInteger(old.lines) || old.lines < 0 || !/^[a-f0-9]{64}$/.test(old.digest ?? ''))) throw sourceError('OBSERVATION_CURSOR_INVALID', 'invalid observation cursor');
    let result;
    try { result = importObservationSource(source.importer, source.data, { sourceId: source.sourceId, maxMalformed: 0, ...(old ? { cursor: old } : {}) }); }
    catch (cause) { const error = sourceError('OBSERVATION_IMPORT_FAILED', 'observation importer failed'); error.cause = cause; throw error; }
    if (!result || !Array.isArray(result.events) || !result.cursor || result.cursor.version !== 1 || result.cursor.sourceId !== source.sourceId || !Number.isSafeInteger(result.cursor.lines) || result.cursor.lines < 0 || !/^[a-f0-9]{64}$/.test(result.cursor.digest ?? '') || (old && result.cursor.lines < old.lines) || !Number.isSafeInteger(result.malformed) || result.malformed !== 0 || ![0, 1].includes(result.partial)) throw sourceError('OBSERVATION_RESULT_INVALID', 'observation import was incomplete or invalid');
    const nextTotal = totalEvents + result.events.length;
    if (nextTotal > 100000) throw sourceError('OBSERVATION_EVENT_LIMIT', 'observation batch exceeds the event limit');
    const residues = []; const ids = new Set(); let lastOrdinal = old?.lines ?? 0;
    let projectIdentity = savedSource && Object.hasOwn(savedSource, 'projectIdentity') ? savedSource.projectIdentity : undefined;
    if (projectIdentity !== undefined && projectIdentity !== null && (typeof projectIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(projectIdentity))) throw sourceError('OBSERVATION_CURSOR_INVALID', 'invalid observation project identity');
    for (const event of result.events) {
      if (!Number.isSafeInteger(event.ordinal) || event.ordinal <= lastOrdinal || event.ordinal > result.cursor.lines) throw sourceError('OBSERVATION_EVENT_ORDER', 'invalid observation event order');
      lastOrdinal = event.ordinal;
      if (event.sourceId !== source.sourceId) throw sourceError('OBSERVATION_SOURCE_IDENTITY', 'observation source identity mismatch');
      const residue = toResidue(event, source.project);
      const observedProject = residue.provenance.projectId;
      if (projectIdentity === undefined || projectIdentity === null) projectIdentity = observedProject;
      else if (observedProject !== null && projectIdentity !== observedProject) throw Object.assign(new Error('observation project identity changed; reconcile the source'), { code: 'OBSERVATION_PROJECT_CHANGED' });
      if (ids.has(residue.sittingId)) throw sourceError('OBSERVATION_EVENT_DUPLICATE', 'duplicate observation event'); ids.add(residue.sittingId);
      if (Object.hasOwn(seen, residue.sittingId)) { if (seen[residue.sittingId] !== residue.contentHash) throw sourceError('OBSERVATION_EVENT_CHANGED', 'previously processed observation changed'); }
      else residues.push(residue);
    }
    const nextCursor = { version: 1, sourceId: source.sourceId, lines: result.cursor.lines, digest: result.cursor.digest };
    totalEvents = nextTotal;
    batches.push({ key, cursor: { project: source.project, ...(projectIdentity === undefined ? {} : { projectIdentity }), cursor: nextCursor }, partial: result.partial, residues, eventIds: [...ids] });
    } catch (error) {
      if (!isolateFailures) throw error;
      const known = ['OBSERVATION_CURSOR_LEGACY', 'OBSERVATION_SCOPE_CHANGED', 'OBSERVATION_PROJECT_CHANGED', 'OBSERVATION_CURSOR_INVALID', 'OBSERVATION_IMPORT_FAILED', 'OBSERVATION_RESULT_INVALID', 'OBSERVATION_EVENT_LIMIT', 'OBSERVATION_EVENT_ORDER', 'OBSERVATION_SOURCE_IDENTITY', 'OBSERVATION_EVENT_DUPLICATE', 'OBSERVATION_EVENT_CHANGED', 'OBSERVATION_EVENT_INVALID'];
      if (!known.includes(error?.code)) throw error;
      const cause = error.cause ?? error;
      const errorClass = ['Error', 'TypeError', 'RangeError'].includes(cause?.name) ? cause.name : 'Error';
      blocked.push({ sourceId: source.sourceId, reason: error.code, errorClass });
    }
  }
  return { cursors, batches, blocked };
}
