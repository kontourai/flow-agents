/** Convert one Ferry observed event to a scrubbed, provenance-bound dream input. */
import { createHash } from 'node:crypto';
import { scrubResidueText } from '../promote/runtime-redaction.js';
import { stripInjectedContent } from '../promote/runtime-transcript.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const safeSource = /^[A-Za-z0-9._:-]{1,128}$/;

export function toolEventResidue(event, project = null) {
  if (!event || typeof event !== 'object' || !safeSource.test(event.sourceId ?? '') || !Number.isSafeInteger(event.ordinal) || event.ordinal < 1 || event.id !== hash(JSON.stringify([event.sourceId, event.ordinal])) || !['tool_start', 'tool_complete'].includes(event.event) || typeof event.session !== 'string' || typeof event.projectId !== 'string' || typeof event.projectName !== 'string' || typeof event.tool !== 'string' || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('invalid observed tool event');
  for (const field of ['input', 'output']) if (event[field] !== undefined && (typeof event[field] !== 'string' || Buffer.byteLength(event[field]) > 1024 * 1024)) throw new Error('invalid observed tool event');
  for (const field of ['session', 'projectId', 'projectName', 'tool', 'timestamp']) if (Buffer.byteLength(event[field]) > 4096) throw new Error('invalid observed tool event');
  if (project !== null && (typeof project !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(project))) throw new Error('invalid observation project');
  const provenance = { sourceId: event.sourceId, eventId: event.id, ordinal: event.ordinal, timestamp: event.timestamp, session: event.session ? hash(event.session) : null, tool: scrubResidueText(stripInjectedContent(event.tool)) || null, project, projectId: event.projectId ? hash(event.projectId) : null, projectName: event.projectName ? scrubResidueText(stripInjectedContent(event.projectName)) || null : null, event: event.event };
  const text = scrubResidueText(JSON.stringify({ event: event.event, tool: stripInjectedContent(event.tool), ...(event.input === undefined ? {} : { input: stripInjectedContent(event.input) }), ...(event.output === undefined ? {} : { output: stripInjectedContent(event.output) }) }));
  const sittingId = `tool-event:${event.id}`;
  const turns = [{ role: 'tool', text, at: event.timestamp }];
  return { source: 'tool-event', sittingId, contentHash: `sha256:${hash(JSON.stringify({ sittingId, provenance, turns }))}`, complete: true, provenance, turns };
}
