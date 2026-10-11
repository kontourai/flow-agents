# Installed engine host

`@kontourai/flow-agents/engine-host` is a kit-neutral one-shot installed-CLI boundary.
Station's SDK, app-server, and ACP adapters continue to own persistent interactive
application sessions. Flow Agents runtime-adapters own kit activation and hooks.
This module owns CLI invocation, bounded subprocess lifetime, transcript parsing,
and explicit execution observations. Kits supply their own stage prompts and results.

Six engine profiles name Codex, Claude Code, Kiro CLI, Cursor Agent, OpenCode, and
Copilot CLI. Kiro IDE, Cursor IDE, and Copilot VS Code are separate declared surfaces;
this runner refuses them rather than presenting CLI evidence as IDE evidence.

## Explicit host authority

`runEngine` requires `executionProfile: 'host-native'` and `hostAccessGranted: true`.
This is an explicit operator grant for a CLI running on the trusted host with its
normal environment and engine-owned sign-in state. It is **not isolated execution**:
host credentials, controller files, and private data are not confined. `allowTools`
is a separate explicit grant for native tool approval flags, not an isolation policy.
Omitting that flag does not revoke permissions saved in engine configuration.
Do not use this profile for an eval that requires controller/oracle confinement.
The existing `./docker-worker` Codex isolated broker export is unchanged. No engine
or authentication fallback occurs. An unsupported isolated engine must be refused
by the consuming host, never redirected to host-native or Codex.

```ts
import { runEngine } from '@kontourai/flow-agents/engine-host';
const receipt = await runEngine({
  engine: 'opencode', workspace: '/path/to/work', prompt: 'Inspect this project',
  model: 'provider/model', timeoutMs: 60000,
  executionProfile: 'host-native', hostAccessGranted: true,
});
```

`detectEngine` resolves executable PATH entries and hashes the resolved entrypoint;
it does not claim authentication readiness or hash dependencies behind a launcher.
`environment` supplies resolved credential values only to the subprocess. Passed
values and additional `redactValues` are stripped from returned output. No secret
resolver, provider routing, credential-store reader, or methodology engine lives here.
Native engine logs/stores remain owned by the engine and may contain its transcript.

The receipt binds engine, canonical workspace, requested model, prompt digest, and
entrypoint digest. Physical provider/model identity remains unverified. Usage is
unknown unless an observed terminal contract reports complete token totals; OpenCode
per-step counters and Copilot premium-request counters are not full token totals.
CLI exit zero alone is insufficient: a recognized successful terminal event is needed.
Kiro error streams are classified. Its 2.24.0 v2 ACP success contract is admitted
only for `runStarted` protocol 1 plus a `runFinished` terminal with end_turn, a
nontruncated finalText and observed session identity. Other versions fail closed.
The serialized fields were observed in the installed binary; live Kiro success is
NOT_VERIFIED due its account usage limit. Fixture conformance proves parsing only.

Cancellation/deadline/output overflow kill the spawned Unix process group and await
close. Windows native executables are supported, but `.cmd`/`.bat` wrappers require
a platform resolver and are refused; Windows descendant termination is NOT_VERIFIED.
There is no automatic retry. Output capture is bounded across stdout and stderr.

## Source survey and verification

Design survey at Flow Agents base `e544e612`: `src/runtime-adapters.ts` composes
kit activation and event/hook policy; `integrations/codex-host/docker-worker.mjs`
is a trusted immutable-container Codex/Responses-broker primitive; its public
legacy export is retained. Station source in
`src-server/providers/adapters/claude-adapter.ts`, `codex-adapter.ts`, and ACP adapters
owns richer persistent sessions, permissions, collaboration, and app presentation.
This module does not port those session executors or invent kit methodology.

`runIsolatedEngine` admits only an implemented broker protocol. Today Codex delegates
to the existing `runCodexDockerWorker`; other engines are explicitly refused.
A new isolated engine needs its own correctly scoped provider protocol, model
routing, and real container evidence before admission. Generic API keys or native
credential-store mounts do not qualify as isolated broker authentication.

`readOnlyWorkspace: true` compares the existing workspaceRevision tree digest before
and after native execution. A difference returns `workspace_modified`. It observes
persistent changes in that tree; it cannot prove that transient edits never occurred
or that paths outside it were untouched. Unsupported tree entries fail closed.

On 2026-10-10, the compiled runner executed on brian-media through six native CLI
profiles with the prompt `Reply exactly ENGINE_OK. Do not use tools.` Codex,
OpenCode, and Copilot returned `completed` and the exact final. Claude returned
an expired/unrefreshable OAuth error, Cursor returned missing authentication, and
Kiro 2.24.0 returned monthly usage limit from its explicit v2 ACP engine. Those are
engine errors, not mocked successful execution. Native smoke does not qualify the
isolated broker profile or any IDE surface. Private receipts remain on that host
under `/tmp/flow-engine-smoke-20261010/*.runner-receipt.json`; no authentication
values are published here. Unit tests exercise real fake child processes for
split streams, terminal evidence, exit failures, process-group cancellation,
combined output bounds, redaction, identity, read-only changes and explicit refusal.

Muse is an additional explicit native CLI profile. Its version-qualified MSP parser
requires one session, a correlated started run and a single completed terminal.
The terminal text is returned exactly; echo protocol qualification does not verify
a model provider or account. Muse 1.4.4 on brian-media lacks usable Meta credentials
and remains **NOT_VERIFIED** for provider-backed workflows. Grok and Copilot were
not substituted. Native login remains owned by the selected engine.

OpenCode's JSONL profile returns text belonging to its final `stop` message only.
Every step and part must bind the current message and session. Tool-step narration
is retained in the raw transcript but excluded from the final message; prose or
fenced JSON within the terminal message remains intact. This parser does not
repair application output contracts or manufacture a successful artifact result.

Large native inputs use engine-owned transports: OpenCode reads the exact prompt
from stdin, and `runEngine` supplies Muse with `--prompt-file` in an invocation-owned
0700 temporary directory containing a 0400 UTF-8 file outside the application
workspace. The file is removed after process settlement on success, errors,
timeout or cancellation. No raw prompt is added to wrapper diagnostics. Prompt
identity remains the digest of the original UTF-8 bytes. Admission is bounded to
16 MiB; it does not depend on OS command-line argument limits.

OpenCode stdin behavior is source-confirmed in
[v1.18.28 run.ts](https://github.com/anomalyco/opencode/blob/v1.18.28/packages/opencode/src/cli/cmd/run.ts#L400),
and Muse 1.4.4 documents `exec --prompt-file` in its installed CLI help. The pure
`prepareEngineInvocation` helper retains Muse positional invocation unless a
`promptFile` is explicitly supplied; filesystem staging belongs to `runEngine`.
