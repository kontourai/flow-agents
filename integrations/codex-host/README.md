# Docker host identity

The public `@kontourai/flow-agents/docker-worker` module provides `dockerHostUserArgs(platform, {uid, gid})` and `resolveDockerHostIdentity({platform})` for worker and check-container admission.

On Linux, bind mounts retain the controller's filesystem ownership. A default root container with all capabilities dropped cannot read another user's `0400` context or enter their `0700` workspace. The resolver reads the actual controller UID/GID and Docker daemon security options, then returns `args: ['--user', '<uid>:<gid>']`. Callers add those arguments to their normal Docker command; host file modes, dropped capabilities and read-only mounts stay enforced.

The production worker verifies `docker inspect` reports the requested `Config.User` and the default `HostConfig.UsernsMode`, and retains both observations with the controller identity and daemon options. Rootless or remapped Linux Docker identity schemes are not qualified and are refused; the resolver does not override user namespaces or change host ownership. Docker Desktop keeps its existing user defaults, with host UID mapping explicitly unverified.

A Linux mount/bootstrap proof demonstrates context reads, Git initialization/add/commit, source writes and the installed Codex version under this identity. It is separate from actual model/provider execution proof.

## Worker network admission

`runCodexDockerWorker` accepts `bridge`, `none`, or an existing named local Docker bridge. Named bridges are inspected on the selected Docker daemon (`DOCKER_HOST` is honored), then the worker is created using the observed immutable network ID. Before starting, container inspection must report that same network mode and exactly one attachment to that admitted name, with the same ID when populated (Docker fills an empty attachment ID on start). The network is re-inspected by immutable ID before start. A deleted/replaced name, wrong attachment or extra network fails closed and removes the created container before any model process starts. Host, container, overlay and macvlan modes are refused. The receipt retains both the requested name and admitted ID; this does not create networks or alter firewall rules.
