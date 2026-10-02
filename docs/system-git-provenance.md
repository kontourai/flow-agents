# System Git provenance for local inspection

Local committed configuration and immutable history inspection use fixed system Git paths. Repository files, ambient `PATH`, Git environment variables, and configuration cannot select the executable. Git configuration capable of launching fsmonitor, hooks, external diff or text conversion is disabled; replacement objects are ignored. Executable identity and its protected lookup/resolved paths are checked before and after execution. The TypeScript API and installed CommonJS hooks consume the same shipped primitive at `scripts/hooks/lib/trusted-git.js`; CLI telemetry, shared-root discovery, committed hook policy, evidence capture, Stop snapshots, and freshness/delivery advisories and staged quality reads use that primitive. This synchronous CommonJS implementation is a deliberate narrow runtime exception: installed hooks must share the policy on the supported Node22 floor without synchronously requiring an ESM build. The TypeScript public facade retains the existing typed API; the policy has one implementation.

The security invariant is a host-provisioned system executable protected from replacement by the invoking user. Visible UID0 is an appropriate ownership check in the initial Linux namespace and on the existing macOS system paths. It is not a portable host-root identity across user namespaces.

## Linux namespaces

Linux reports unmapped filesystem owners through the kernel overflow UID. A root-owned `/usr/bin/git` can therefore appear owned by UID65534 in a systemd user service, even though its actual host permissions have not changed. The overflow value is lossy: it does not prove the original owner was root. The second column of `/proc/self/uid_map` describes the parent namespace, which can itself be nested; it does not necessarily describe the original host.

Local inspection accepts either the initial identity mapping or a bounded namespace mapping containing exactly the invoking UID, with one mapped ID. This supports systemd's self mapping and nested native Codex mappings such as `1002 0 1`. For the namespace route:

- Real and effective user/group IDs must agree, so the kernel's access check describes the invoking process.
- The kernel overflow UID must be valid and outside the caller mapping.
- The executable and every lookup/resolved path component must have that unmapped owner. A namespace caller-owned file is rejected even when its visible UID is0.
- Group/world writable components are rejected. Kernel write access must be denied for the executable and all containing directories; only permission denial, immutable-file denial, or a read-only filesystem establishes that result.
- Symlink ownership, containing directories and target routes are inspected. A trusted final target does not make a caller-controlled lookup route safe.
- Missing, malformed or unsupported mappings, uncertain access errors, and executable identity changes fail closed.

This policy trusts the host-provisioned system paths and mount environment. It does not reconstruct exact host ownership, authenticate arbitrary mounted binaries, or create a privilege boundary against malicious same-user namespace/code rewriting. The local-state limitations in [the workflow guide](./workflow-usage-guide.md) still apply. Additional namespace mapping layouts require an explicit supported policy and evidence rather than a blanket overflow-UID exception.

Linux documents the mapping and overflow semantics in [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html) and the real-ID access semantics in [access(2)](https://man7.org/linux/man-pages/man2/access.2.html).

## Separate signed authority

The signed lifecycle coordinator, privileged helper and verification key retain their stricter ownership and authentication rules. This local Git policy does not authorize overflow-owned authority files. Invoke lifecycle actions through their supported trusted host public executor. An unavailable authority route is a visible integration blocker, not permission to relax signature, principal, helper or key checks.

## Verification

`bash evals/integration/test_trusted_git_namespace.sh` exercises committed policy through the public CLI in host, isolated systemd and nested namespaces, checks the exact commit and policy digest, starts a real actor-bound canonical run, executes shipped evidence capture and Stop confirmation against its actual workspace, and uses disposable mount namespaces for caller-owned lookup/executable negative controls. Unsafe Git must leave capture unchanged and cannot confirm a pass. The fixture also checks unrelated-actor delivery advisories and freshness ancestry status semantics. It never changes the running Station default service. Unsupported Linux runtime prerequisites return an explicit non-success skip; macOS/Windows unit checks do not substitute for this Linux evidence. Unit tests separately preserve hostile Git-configuration behavior and detect executable metadata changes after a real Git invocation.

Unsupported or unsafe namespace inspection produces a fail-closed public configuration report with a bounded executable-trust reason. It does not include raw Git stderr, repository contents or environment values. Use a supported host context or the documented single-caller namespace; do not change ownership, create an executable override, or disable configuration enforcement as recovery.
