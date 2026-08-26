# Retained narrative reader test fixture

`src/cli/narrative-retained-reader.test.mjs` constructs its generated retained
fixture in a reclaimable temporary directory with the public snapshot, compose,
and write APIs, then reopens it through the public built entry point. It covers
default and custom retained-output roots, a simulated restart/compiler upgrade,
corruption and limits, mutable-origin isolation, queued revocation, a no-write
fingerprint, and the narrow browser process projection.

The browser-safe projection exposes only recorded compiler provenance,
aggregate capture-channel status counts, known capture-gap classes, runtime
coverage counts, bounded typed action categories, and turn ordinals/boundary
derivation. It omits foreign
Flow/Surface payloads, source ids, paths, commands, session ids, statement
text, capture notes/refs, and tool-result drill-down. Flow Agents does not use
this projection to assert semantic answer support or current gate validity;
Station owns those associations and any separately authorized drill-down. The
unit does not claim an npm package proof; packed-consumer verification is a
separate release/readiness check.
