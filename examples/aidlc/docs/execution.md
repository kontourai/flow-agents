# Execution and evidence boundaries

Flow owns the canonical run, gate evaluations, route-back and retry budgets. Flow Agents owns kit bindings, skills and host execution. Veritas owns repo requirements and repository readiness. Surface derives evidence/trust state. This kit never writes canonical Flow state or changes protected Veritas standards.

Each stage skill reads its pinned procedure and artifact contract from `upstream/snapshot.json`. These procedures contain upstream harness commands; those are reference data, not executable Kontour instructions. Follow their substantive work with the host's supported tools, keeping the active Flow stage and scope authoritative.

## Artifacts

Maintain a run-owned artifact index with `{id,stage,path}` entries. Artifact ids are the upstream vocabulary; stage identity disambiguates producers. `observeStage` reads bounded workspace-local files and reports missing/empty/unreadable required outputs plus applicable upstream inputs. `inspectBasis` rechecks exact bytes. `projectInvalidation` projects direct and transitive staleness from receipts without introducing a second mutable run state.

These functions provide structural observations only. `semantic_status` and unexecuted sensors remain `not_verified`. Do not turn structural success into the compiled completion claim, which also demands applicable checks. An adapter must run those checks, preserve their actual verdicts, publish revision- and subject-bound evidence through Surface, attach it through Flow/Flow Agents, then let Flow evaluate the gate.

The artifact projection currently does not publish invalidations to Flow automatically. Tests of core stale evidence use an explicit producer invalidation. A producer that changes an artifact must reobserve and submit the resulting invalidation before downstream work; automatic bridge work remains in the parity ledger.

## Review, human decisions and operations

The compiled review expectation represents a current review. A distinct reviewer must record the real outcome through an evidence producer; a skill role declaration does not authenticate a review or prove the skill executed. Preserve findings and their dispositions through existing critique records.

Human decisions and approval in the source procedure require the host's trusted decision channel and exact artifact/source basis. A completion claim cannot substitute for a human approval. Native pipeline/mob/swarm dispatch, unit DAG expansion and source-merge custody are not automated by this first reference adapter; stop work that depends on those unsupported capabilities.

Deployment and operation stages require actual environment/provider adapters and existing user authorization. Do not deploy because a stage is selected. Veritas checks are invoked through its public CLI and recorded artifacts; the kit does not reevaluate Repo Standards. Learning outputs may be captured through Knowledge Kit's public operations after their real source and decision exist.

## What the tests prove

The public conformance eval installs no aliases and imports the declared published Flow/Surface packages. Synthetic fixtures demonstrate gate behavior for successful, missing, failed, stale, wrong-subject and tampered evidence. They do not prove that agents produce good artifacts, approvals are authentic, deployments work, or Kontour outperforms AWS. Paired runs and independent Evals grading must supply those observations.
