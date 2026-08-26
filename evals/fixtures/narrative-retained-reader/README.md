# Retained narrative reader fixture

`src/cli/narrative-retained-reader.test.mjs` constructs this packed-fixture contract with
the public snapshot, compose, and write APIs, then reopens it through only the public
retained-reader API.  It covers default and custom retained-output roots, a simulated
restart/compiler upgrade, corruption and limits, mutable-origin isolation, queued
revocation, a no-write fingerprint, and the narrow browser process projection.

The browser-safe subpaths intentionally expose only recorded compiler provenance, aggregate
capture-channel status counts, known capture-gap *classes*, runtime coverage counts, and turn
ordinals/boundary derivation. They omit foreign Flow/Surface payloads, source ids, paths,
commands, session ids, statement text, capture notes/refs, and tool-result drill-down. Flow
Agents does not use this projection to assert semantic answer support or current gate validity;
Station owns those associations and any separately authorized drill-down.
