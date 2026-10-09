# Pinned AI-DLC methodology

The AI-DLC reference kit imports the methodology of
[AWS AI-DLC Workflows 2.11.0](https://github.com/awslabs/aidlc-workflows/tree/2a555f7a4387cd1b8254029cccb9fd1e99974574)
at commit `2a555f7a4387cd1b8254029cccb9fd1e99974574`. The imported material is licensed
MIT-0; its original license is retained in `upstream/LICENSE-MIT-0`.

## Snapshot contract

`upstream/snapshot.json` contains `schema_version: "1.0"`, an `upstream` record
with `repository`, `commit`, and `version`, an ordered `stages` array, an `agents`
array, and a `profiles` object. There are **33 stages across five phases**:

| Phase | Stages |
| --- | ---: |
| Initialization | 3 |
| Ideation | 7 |
| Inception | 9 |
| Construction | 7 |
| Operation | 7 |

The **11 profiles** are `bugfix`, `classic`, `enterprise`, `express`, `feature`,
`infra`, `mvp`, `poc`, `refactor`, `security-patch`, and `workshop`. Each profile
has an ordered `stages` list containing exactly the compiled scope grid's
`EXECUTE` entries and `defaults` containing the authored scope's policy values.
`name`, `keywords`, and `description` are routing/display metadata and are
excluded from defaults. Values such as `on`, `off`, `strict`, and `advisory`
remain strings; explicit YAML `true` and `false` remain booleans. Missing
properties remain absent, rather than inventing inherited runtime defaults.

Each stage retains authored execution conditions, agent roles, review settings,
artifact production/consumption, stage dependencies, sensors, scope membership,
unit repetition, and workspace requirements where present in the compiled graph.
It also retains the original authored body in `procedure`, its repository-relative
`source_path`, and `source_digest` (SHA-256 of the entire Markdown source including
frontmatter). These records let a Kontour compiler generate skills while keeping
the source and provenance inspectable.

The **14 authored agent personas** are retained separately, sorted by source path.
Each has `slug`, `source_path`, `source_digest`, the original raw
`source_frontmatter`, and `procedure` (the persona body). Raw frontmatter retains
folded descriptions and harness-specific tool restrictions without pretending
those restrictions enforce anything in a Kontour runtime.

An `EXECUTE` profile entry means the stage is selected; a stage's own
`execution: CONDITIONAL` and `condition` still determine applicability. Retained
`for_each: unit-of-work` declares unit-level repetition; listing a stage once does
not implement independent child-run scheduling. Dependencies on stages omitted
by a profile remain in the source record so compilation must account for them
explicitly instead of silently claiming the full upstream DAG is unchanged.

## Reproduce the import

Prepare the pinned upstream checkout and its already generated Claude distribution
data separately. Then run from this repository:

```sh
node examples/aidlc/scripts/import-upstream.mjs /absolute/path/to/aidlc-workflows
```

An optional second argument selects a temporary output directory for comparison.
The importer verifies the checkout HEAD, version, committed authored input bytes,
and the pinned SHA-256 digests of `stage-graph.json` and `scope-grid.json`. It reads
those data files and the authored Markdown; it never invokes AWS hooks, engines,
packaging code, workflow commands, or commands mentioned in procedure prose.
There is no timestamp or absolute checkout path in the output, so identical inputs
produce byte-identical JSON and license files. Unsupported scope YAML fails loudly.

## What parity means

This snapshot establishes **methodology coverage**, not runtime equivalence.
Kontour can compare stage selection, policy declarations, procedures, artifact
contracts, and review roles against a pinned source without depending on the AWS
engine. The reference kit's runtime is implemented with Kontour products; the
snapshot alone does not prove its behavior.

Upstream procedure bodies include AWS-specific record paths, directives, agent
identifiers, and command names. They are reference material for adapting Kontour
skills. Preserving them does not make those commands available or authorize
executing them. Generated instructions must bind those operations to available
Kontour tools and disclose any unsupported behavior.

Runtime qualification must separately demonstrate stage advancement, conditional
skip decisions, human approvals, sensor failures, review iteration limits, artifact
freshness and downstream invalidation, per-unit execution and joins, source/review
attribution, deployment authority, recovery, and operational feedback. Recording
an upstream setting does not implement that setting, and accepting an artifact
does not prove its contents were reviewed. Required evidence should fail closed
when a check is unavailable or malformed, even where upstream behavior differs.

Treat this fixture as a repeatable testing ground: compare emitted Kontour flow and
skill contracts to the snapshot, run representative profiles, inject failures and
changed inputs, and record product-owned gaps. Update the upstream pin deliberately
with new fixture digests and contract comparisons; never silently import a moving
branch or substitute a second lifecycle engine.

The pinned snapshot is an independent source oracle. Output comparisons should
check it directly, not only compare two outputs generated by the Kontour compiler:
a shared compilation bug could make those outputs agree. A methodology comparison
can verify membership, order, roles, artifacts, policies, and source digests; a
behavior comparison needs AWS and Kontour run outputs for the same input fixtures
and explicit acceptance criteria. Differences should be classified as matching,
intentional stronger enforcement, missing capability, or observed regression.
