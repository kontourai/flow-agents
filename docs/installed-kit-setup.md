# First-run setup for installed kits

Install the kit using `flow-agents kit install`, then configure its public
execution request. Flow Agents owns portable setup and engine invocation; the kit
owns methodology and its parameters. Datum owns provider/model resolution and
secret references. Station's connection and credential registry is optional;
setup works without Station.

Standalone universal homes also support the installed `scripts/kit.js` setup
and doctor commands without an npm installation. Their bundle includes the exact
pinned public Datum implementation and its dependencies. Original licenses and
package versions are recorded beside `build/src/vendor/datum.mjs` in
`datum.licenses/` and `datum.bundle.json`; secret values remain host-resolved at
execution time.

```sh
flow-agents kit setup <kit-id> --dest <installation-root> \
  --workspace <project-directory> --controller-root <private-directory> \
  --engine codex --model <model-name> --auth native --allow-host-execution \
  --prompt 'Build the requested project' --output request.json --dry-run
```

Choose an engine explicitly: `codex`, `claude`, `kiro`, `cursor`, `opencode`, or
`copilot`, or `muse`. Native execution uses a **trusted host** and the engine's native login
store. It is not a Docker sandbox. `--allow-host-execution` is required to explicitly authorize this host execution profile. Run the engine's sign-in flow first. For Codex,
use `codex login`, or `codex login --device-auth` on a headless host; `codex login
status` checks login readiness. Codex can keep credentials in `~/.codex/auth.json`
**or** an OS credential store, according to `cli_auth_credentials_store`
(`file`, `keyring`, `auto`, `ephemeral`). A login does not guarantee a file exists.
Flow Agents never invents a cache file or implements an OAuth refresh service.
Other native engines retain ownership of their credentials; doctor reports their
native authentication as `NOT_VERIFIED` until a bounded engine invocation proves it.

Remove `--dry-run` to write a new private request file. Existing files are never
overwritten. `--parameters-file parameters.json` supplies kit-owned parameters;
`--request-template request.json` is an advanced starting point. Setup always
binds the installed kit's verified content, source path, engine, model, workspace,
and finite limits. Defaults are 32 turns, 128 provider requests and 3600 seconds;
use `--max-turns`, `--max-provider-requests` and `--timeout-s` to change them.
Native CLI provider-request budgets are explicitly marked `not-enforced`; the request does not claim control of an opaque engine's API-call count. Docker broker budgets are enforced by the host broker. The requested harness is the selected engine; harness version remains unknown until observed.
The controller must stay disjoint from the model workspace and installed kit.
Existing controller directories require private permissions. Secret fields and
recognizable credential literals are refused, including in templates.

For an API-key provider configured in Datum, select `--provider model@provider`.
This resolves model/provider and the original auth reference without reading its
value. Alternatively pass `--auth-ref auth-reference.json` containing exactly one
Datum reference: `{ "env": "PROVIDER_KEY" }`, `{ "keychain": { "service":
"provider", "account": "user" } }`, or `{ "op": "op://Private/provider/key" }`.
Never place the value itself in JSON or command arguments. `--auth native`
explicitly retains engine-owned login even when a Datum model is selected.
Reference backend availability does not prove that a secret exists or that the
provider accepts it. Configured provider kind, endpoint and auth-reference authority are refreshed before execution; changed references require setup again. The supported native API-key adapter is Claude Code with an anthropic-compatible Datum provider, using Datum’s native settings generator and `ANTHROPIC_API_KEY` subprocess environment. Other native API-key adapters are refused; use their engine-owned login.
Only explicit trusted-host execution materializes it, using
Datum's existing `materializeAuthRef`; setup and doctor do not read keychain or
1Password values.

Prepare a generic worker with Node, Git, Python and a pinned Codex CLI:

```sh
flow-agents kit prepare-worker --codex-version <exact-codex-version>
```

This builds the packaged generic Dockerfile and prints its observed local immutable
image ID. It contains no task, evaluation, policy, or credentials. The base image
uses Node 24 Debian slim; specialized project toolchains can extend this Dockerfile.
Building an image is not runtime or provider qualification.

The supported Docker route is the Codex host broker. Select `--isolation docker`
and `--image sha256:<64-hex-digest>` (the local immutable Docker image ID), plus explicit
`--auth-file <private-existing-codex-cache>` or a Datum API-key reference. The file
must remain outside the project and installed kit, with private permissions.
Native cache mounts are refused. The broker receives host credentials and grants
workers a short-lived, model-bound capability. It does not refresh OAuth tokens;
file readiness is not token freshness or successful provider authorization.
Non-Codex Docker engines require a separately implemented trusted-host session
adapter and are refused. A missing adapter must never fall back to Codex.

```sh
flow-agents kit doctor --request request.json
flow-agents kit run <kit-id> --dest <installation-root> \
  --request request.json --controller-root <private-directory>
```

Doctor reports installation, native login status when supported, Datum backend
availability, or private Codex file readiness. Docker mode also checks the daemon and configured local image, without requiring a host-native Codex binary.
It suppresses subprocess output and never prints credentials. Its `PASS` means
only the named check passed; `provider-auth` remains `NOT_VERIFIED` before a live
bounded call. A request is written even if preflight fails, so it can be inspected
and repaired; the exit code is 1 for failed preflight and 2 for invalid configuration.
Docker image/toolchain contents and kit-specific parameter semantics remain owned
by the image and installed kit respectively; setup does not manufacture qualification.
