/** Convert one Ferry observed event to a scrubbed, provenance-bound dream input. */
import { createHash } from 'node:crypto';
import { scrubResidueText } from '../promote/runtime-redaction.js';
import { stripInjectedContent } from '../promote/runtime-transcript.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const safeSource = /^[A-Za-z0-9._:-]{1,128}$/;

export function toolEventResidue(event) {
  if (!event || typeof event !== 'object' || !safeSource.test(event.sourceId ?? '') || !Number.isSafeInteger(event.ordinal) || event.ordinal < 1 || event.id !== hash(JSON.stringify([event.sourceId, event.ordinal])) || !['tool_start', 'tool_complete'].includes(event.event) || typeof event.session !== 'string' || !event.session || typeof event.tool !== 'string' || !event.tool || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('invalid observed tool event');
  for (const field of ['input', 'output']) if (event[field] !== undefined && typeof event[field] !== 'string') throw new Error('invalid observed tool event');
  const provenance = { sourceId: event.sourceId, eventId: event.id, ordinal: event.ordinal, timestamp: event.timestamp, session: hash(event.session), tool: scrubResidueText(event.tool), event: event.event };
  const text = scrubResidueText(JSON.stringify({ event: event.event, tool: stripInjectedContent(event.tool), ...(event.input === undefined ? {} : { input: stripInjectedContent(event.input) }), ...(event.output === undefined ? {} : { output: stripInjectedContent(event.output) }) }));
  const sittingId = `tool-event:${event.id}`;
  const turns = [{ role: 'tool', text, at: event.timestamp }];
  return { source: 'tool-event', sittingId, contentHash: `sha256:${hash(JSON.stringify({ sittingId, provenance, turns }))}`, complete: true, provenance, turns };
}
