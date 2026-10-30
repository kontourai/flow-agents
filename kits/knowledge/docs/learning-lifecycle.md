# Reviewed learning lifecycle

The `knowledge.learning-lifecycle` adapter and the public package exports
`knowledge-learning-contract`, `knowledge-learning` and `knowledge-learning-file`
own the `knowledge.learning/v1` lifecycle. A Knowledge record's ordinary
`status: active` is content storage status and does not activate a learning.

A host constructs `createKnowledgeLearningLifecycle(store, host)`. The host
functions derive the current person/system identity and allowed operation from
verified ingress; none can be supplied in intent JSON. `authorize` returns the
observed actor, its decision capability and an `assertCurrent` fence.
`readEvidence` resolves each exact authority/kind/id/revision within the selected
scope. Missing or withdrawn source/target authority withholds the whole learning
rather than exposing its body or treating missing evidence as support.

A proposal names its body, expected effect, scope, supporting/counter/conflict
references and intended target consumers. Evaluation and decision are recorded
separately. Approval does not activate a proposal: `activate` registers the
approved exact content revision for the named target consumers. Consumers read
`active(scope)` at their authorized execution boundary and record that exact
revision when it contributes context. This registration does not install an
executable Skill, publish an artifact, grant tool permissions or prove a target
consumed it. Those effects require their own existing owners and receipts.

`observe-effect` retains supported, countered or unresolved observations with
source references. No observations means unobserved, never successful. Retirement
and supersession stop future active-set contribution while retaining the prior
proposal, decision, activation and effect history. A replacement must already be
active at the exact selected revision and within the same scope.

Each typed intent carries its stable identity and expected record revision.
A changed intent under an existing identity is refused; replay after a lost
response returns the original owner receipt. Current authorization still applies
to replay. The file store serializes competing writers with the existing subject
lock and commits the registry plus receipt through the private durable writer.
After an ambiguous commit response, retry only the original intent identity;
never invent a new activation intent to obtain a green response.

The existing host-owned root must be private and outside worker-writable source
storage. The file adapter checks ownership, modes, symlinks, hardlinks, bounds,
root identity and retained lifecycle consistency. These checks do not isolate a
hostile process using the same OS user. A stale subject lock remains an explicit
operator recovery condition after owner quiescence; it is not automatically
removed by an age timeout. Unreadable/corrupt/unsupported state is unavailable,
not an empty healthy active set. Record/receipt capacity fails closed without
evicting operation identities or history.

The API retains owner decisions and observations. It does not independently
certify a human's semantic judgment, source truth, deployed behavior, quality
improvement or billing savings. Station and other consumers must preserve those
boundaries when presenting a lifecycle or completion badge.
