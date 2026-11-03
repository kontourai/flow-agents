/**
 * Injected-memory marker (#669, consumed by injection in #672).
 *
 * Dependency-free on purpose: the injection hook path imports this module
 * without loading transcript parsing (Ferry/Thread). Exported names are a
 * stable contract:
 *
 *   INJECTED_MEMORY_OPEN, INJECTED_MEMORY_CLOSE
 *
 * Anything #672 injects into a session must be wrapped between the two
 * markers. Runtime-session ingest removes every such block (and, for an
 * unterminated block, everything after the opening marker in that text
 * block), so injected memory is never re-ingested as conversation.
 *
 * @module memory-marker
 */

export const INJECTED_MEMORY_OPEN = "<flow-agents-injected-memory>";
export const INJECTED_MEMORY_CLOSE = "</flow-agents-injected-memory>";
