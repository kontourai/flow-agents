---
title: Survey review transports for workflow hosts
---

# Survey review transports for workflow hosts

A workflow host can present evidence and proposed decisions in Survey's browser
workbench or MCP App, retain the review events, and apply the result through its
own workflow authority. Flow Agents already exports the provider-neutral review
work and paused-gate adapters. The UI is optional; it is not a new Flow gate kind
or an engine-specific agent framework.

## Choose the workflow boundary

| Situation | Application boundary |
| --- | --- |
| A persisted Flow gate is blocked or paused on explicitly classified review expectations | Use the Flow Agents discovery and paused-gate adapters below. |
| A kit is waiting for an operator decision during an active stage | The kit owns checkpoint admission, artifact freshness, budget and decision application. Use Survey's producer callback without pretending the run is paused. |
| Protected Veritas Standards need approval | Veritas owns the authority and attestation contract. A local review record alone does not supply a human approval artifact. |

For example, the [AI-DLC Kit guide](https://kontourai.github.io/aidlc-kit/docs/using-the-kit.html)
describes its optional requirements review command. The kit validates its sealed
checkpoint and current artifacts before recording its canonical decision. Its
review UI does not itself run a model or advance Flow.

## Provision Survey independently

The examples use the published Survey 8.1.0 transport package and require Node
22 or later. Flow Agents 8.0.1 retains its own Survey dependency; installing a
separate UI package does not replace that dependency or grant workflow authority.
A host owns the producer-created session file, its access permissions and its
lifecycle. Do not point the commands at a caller-created approval document.

For a producer-created session at an absolute path:

```sh
npx --yes --package=@kontourai/survey@8.1.0 survey-review-console \
  --session /absolute/path/review-session.json --port 4243
```

The CLI starts a loopback browser workbench. It persists review events; its CLI
arguments do not configure a workflow application callback.

An MCP-capable host can launch the same session through stdio:

```sh
npx --yes --package=@kontourai/survey@8.1.0 survey-review-mcp \
  --session /absolute/path/review-session.json
```

Survey supplies queue/item/decision tools and an embedded HTML MCP App resource
using `text/html;profile=mcp-app`. A client that supports MCP Apps can display the
review card; other clients can use the tool response. The browser and MCP
transports share session persistence and locking. MCP calls and `session.actor`
labels are not authenticated human identities.

To add the browser's **Send review to workflow** action, a producer imports the
public `@kontourai/survey/review-console` module:

```js
import { startReviewConsoleServer } from '@kontourai/survey/review-console';

const server = await startReviewConsoleServer({
  sessionPath: '/absolute/path/review-session.json',
  port: 0,
  producerApply: {
    binding: producerOwnedQueueBinding,
    apply: applyCurrentReviewIdempotently,
  },
});
// Present server.url and close this owned server when the review ends.
```

The two producer capabilities in this sketch must be implemented by the host.
The binding comes from the original queue construction, not from a browser
request. Survey derives the result from persisted events against that binding,
requires all items resolved, and calls `apply` with the record, events, results
and revision. The producer revalidates current domain state and authentication
under its own lock, applies idempotently, and returns `{reference, summary}`.
The callback must recover an existing canonical receipt if the workflow write
succeeded but saving Survey's application marker failed. This is a cross-store
operation; the two stores do not share a transaction.

## Discover and continue a paused Flow gate

These exports are available from `@kontourai/flow-agents`:

1. Load the persisted run and capture its exact `flowRunHead` through Flow's public API.
2. Call `discoverSurveyGateReviewWork` with `runId`, `cwd`, `gate`,
   `expectedRunHead` and explicit `reviewExpectationIds`. Discovery requires a
   persisted blocking outcome and selects only missing, required expectations.
3. Have the configured producer construct actual candidate-bearing `ReviewItem`s
   with source/extraction provenance. `bindSurveyGateReviewItem` validates claim
   targets and adds immutable workflow correlation. Alternatively,
   `publishSurveyGateReviewWork` composes discovery, producer construction and
   publication through a host-owned queue with an idempotency key.
4. Present the resulting server-owned session through Survey. Retain its original
   binding and immutable workflow subject association.
5. Configure `createSurveyFlowGateAdapter({reviewSessions})` once. Its resolver
   accepts an opaque session reference and returns the persisted `record`,
   `events`, `currentSnapshot`, `currentEventCount`, `projectionSource` and
   `workflowSubjectRef` from the host's store.
6. Call `continuePausedGate` on that adapter, or
   `continuePausedFlowGateFromSurvey(input, dependencies)`, with `runId`, `cwd`,
   `gate`, an exact current `expectedRunHead`, `reviewSessionRef` and an explicit
   lifecycle `resume` request containing its reason and authority.

The continuation adapter derives Survey's canonical reviewed trust input and
checks that it matches the gate and subject. Flow owns the atomic evidence
attachment, evaluation and pass-only resume. Stale, incomplete, foreign or
mismatched review state cannot change the run; a non-passing review remains
inspectable without resuming. A stale run head requires a fresh admission and
review of currency, not substitution of a newer digest into an old approval.

## Host responsibilities

The host must provide durable queue/session storage, producer candidates and
provenance, immutable subject/basis bindings, concurrency control, current-state
validation, idempotent application and explicit lifecycle authority. If the
workflow requires a human authority, the host must authenticate the reviewer
and retain a durable approval artifact binding that identity to the exact
reviewed basis and action. A browser interaction, MCP tool call, actor string or
producer reference alone proves only a host-observed interaction.

Survey owns review precedence and event replay; Surface owns trust derivation;
Flow owns process progression; Veritas owns governance; Flow Agents composes the
public contracts. See the [paused-gate decision](decisions/survey-evidence-flow-gates.md)
and [engine/kit boundary](architecture-engine-and-kits.md) for the underlying contracts.
