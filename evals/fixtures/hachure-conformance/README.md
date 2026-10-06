# Hachure 0.16.0 conformance vectors (vendored)

`hachure-0.16.0.tgz` is the unmodified npm tarball of `hachure@0.16.0` (MIT,
https://github.com/hachure-org/spec), published 2026-09-28. Its registry integrity is
`sha512-ehgfts5BDLX5xTk6zs2lvr3PVUf2wFeCVnFIuFYJNx6RlKQJuWuhWlIn+glJbmdLdfYCjDTcAbjagR/OkfpLuQ==`,
and `evals/integration/test_workflow_sidecar_writer.sh` refuses the file if its sha512 differs.

Why a vendored tarball and not a dependency: the portfolio layer doctrine has products speak
the trust format through Surface, and `scripts/check-hachure-boundary.mjs` refuses any
`hachure` declaration in `package.json`, devDependencies included. The writer suite needs the
status-function "3" conformance vectors (`conformance/manifest.json` declares
`appliesTo.statusFunctionVersion: "3"`) to check the status function this repository now
derives under, and the only hachure reachable through a dependency graph is 0.15 (via
`@kontourai/flow`), whose vectors are for status function "2". Only `package/conformance/` is
extracted and read; no code from the tarball is executed.

To move to a newer release: replace the tarball with `npm pack hachure@<version>`, and update the
pinned integrity in the writer suite and this file.
