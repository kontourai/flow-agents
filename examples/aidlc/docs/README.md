# AI-DLC Reference Kit

AWS AI-DLC's pinned 33-stage methodology and 11 profiles, expressed through Kontour's existing Flow definitions and Flow Agents kit contracts. This independently installable reference exercises the same extension path available to external kit authors. It is not activated as a default Builder replacement.

The current implementation reproduces profile selection and stage contracts, provides agent stage skills, fingerprints artifact inputs/outputs, projects dependency invalidation, and tests real published Flow/Surface gate behavior. Full AWS runtime equivalence and generated-output effectiveness remain unverified; [parity.json](parity.json) is the explicit capability ledger.

Delivery is tracked by [Flow Agents #1439](https://github.com/kontourai/flow-agents/issues/1439) under [Ops #173](https://github.com/kontourai/ops/issues/173). The program's runtime and output-quality exit criteria remain distinct from this reference's contract tests.

From the Flow Agents source checkout:

```sh
npm run test:aidlc
npm run eval:aidlc
node examples/aidlc/scripts/compile.mjs --check
node examples/aidlc/scripts/compare.mjs method
node examples/aidlc/evals/public-flow-conformance.mjs
node build/src/cli.js kit install examples/aidlc --dest /path/to/workspace
node build/src/cli.js kit activate --dest /path/to/workspace --format json
```

Kit installation/activation and canonical run startup are different checks. The replica ships one declared Flow Definition per profile. Start through the installed runtime's public `workflow start` interface, selecting `aidlc.feature`, `aidlc.bugfix`, or another declared profile. Supply the actual work-item, acceptance criteria and workspace inputs required by that runtime. Do not create synthetic delivery authority to make a demonstration pass.

For a greenfield profile, `compileProfile(snapshot, profile, {projectType:'greenfield'})` omits brownfield reverse engineering. Compile and pin that exact definition before starting a separate run; never overwrite an active run's definition.

## Comparison ground

`evals/corpus.json` freezes two initial inputs and structural artifact rubrics. Record AWS and Kontour outputs separately with the same input digest, model, harness and budget. Each result needs `status`, `identity:{revision,model,harness}`, `budget:{max_tokens}`, `input_digest`, and `artifacts:{path:content}`. Include measured economics or null; missing cost is not zero.

```sh
node examples/aidlc/scripts/compare.mjs outputs case.json aws-result.json kontour-result.json
```

The comparator checks completeness against a frozen rubric and refuses unbound or incomparable runs. It never infers semantic quality or superiority from artifact shape. Independent semantic grading, experimental assignment and causal effectiveness belong to Evals (Ops #142). No paired model runs have been performed by installing this kit.

`scripts/capture-run.mjs` runs an explicitly configured adapter through Flow's public command-capture CLI, collects workspace-local artifacts, and retains the actual command receipt in a separate Flow run. Every expected output must be absent before the command; a rerun cannot borrow leftover output from an earlier run. Use an adapter configuration with `argv`, `identity`, `budget`, and optional `timeout_ms`. A whole argv item `{case_file}` receives the temporary frozen case input path. Adapter identity is configured metadata; the capture proves which command ran, not which provider/model that command secretly used.

```sh
node examples/aidlc/scripts/capture-run.mjs case.json aws-adapter.json /path/to/aws-workspace aws-result.json
node examples/aidlc/scripts/capture-run.mjs case.json kontour-adapter.json /path/to/kontour-workspace kontour-result.json
```

See [execution.md](execution.md) for evidence ownership, [methodology.md](methodology.md) for the pinned upstream method, and [parity.json](parity.json) for unsupported behaviors. Re-run the compiler check and conformance suite when updating the upstream snapshot or product package versions.
