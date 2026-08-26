# Changelog

## [6.1.0](https://github.com/kontourai/flow-agents/compare/v6.0.0...v6.1.0) (2026-08-24)


### Features

* **cli:** intercept --help before any verb runs; derive help from the enforcing option sets ([#1298](https://github.com/kontourai/flow-agents/issues/1298)) ([43b2b08](https://github.com/kontourai/flow-agents/commit/43b2b0870450bac9ff97aa398ccd7556dc7b97b3))
* **cli:** one-pass contract reports on the builder.build critical path ([#1301](https://github.com/kontourai/flow-agents/issues/1301)) ([5f8684b](https://github.com/kontourai/flow-agents/commit/5f8684b2da9f420b787ceacd90999e8f8d1e3005))
* **delivery:** project accepted gaps from delivery/DECLARED as aging Console records ([#1267](https://github.com/kontourai/flow-agents/issues/1267)) ([cc1456f](https://github.com/kontourai/flow-agents/commit/cc1456fdbb934c83041897cef46ea3315ac65d46))
* **kit:** status reads become conditional — the steering contract, taught accurately (11 → 0 unconditional mandates) ([#1269](https://github.com/kontourai/flow-agents/issues/1269)) ([07e9384](https://github.com/kontourai/flow-agents/commit/07e9384651d17bfd332b65f9f8f71eeabca0fd88))
* **telemetry,delivery:** stop-gate summary record + accepted-gaps projection ([#1266](https://github.com/kontourai/flow-agents/issues/1266), [#1267](https://github.com/kontourai/flow-agents/issues/1267)) ([#1268](https://github.com/kontourai/flow-agents/issues/1268)) ([6f742d8](https://github.com/kontourai/flow-agents/commit/6f742d8d8852564bf5a161f8d54fe2585cc110d0))
* **telemetry:** emit the stop-gate cross-check summary as a machine-readable record ([#1266](https://github.com/kontourai/flow-agents/issues/1266)) ([9ca8078](https://github.com/kontourai/flow-agents/commit/9ca8078cb4b3ff374522e823eb89c47f335e64a6))
* **telemetry:** local-only measurement trend sink that reports changes, not scores ([#1258](https://github.com/kontourai/flow-agents/issues/1258)) ([#1262](https://github.com/kontourai/flow-agents/issues/1262)) ([16d9203](https://github.com/kontourai/flow-agents/commit/16d92036bb577cb2f85ed62f67bc575a09b71928))
* **telemetry:** the CLI witnesses its own transitions, and a kit-agnostic scorer derives gate cost and outcome from them ([#1274](https://github.com/kontourai/flow-agents/issues/1274)) ([a534834](https://github.com/kontourai/flow-agents/commit/a5348344167d4ee90bfed6fe199956b771c1fe73))
* **workflow:** route-back cost disclosure — declared facts before, observed outcome after ([#1304](https://github.com/kontourai/flow-agents/issues/1304)) ([#1317](https://github.com/kontourai/flow-agents/issues/1317)) ([4056348](https://github.com/kontourai/flow-agents/commit/4056348d7acce863a8a10036a852cb9b03f0cb8b))


### Fixes

* **assignment-provider:** bootstrap preserves tracked settings byte-identically ([#1305](https://github.com/kontourai/flow-agents/issues/1305)) ([#1310](https://github.com/kontourai/flow-agents/issues/1310)) ([7502550](https://github.com/kontourai/flow-agents/commit/7502550745e85105e287808d2132815a90279811))
* **builder:** refusals name their cause and their remedy ([#1282](https://github.com/kontourai/flow-agents/issues/1282)) ([8bac992](https://github.com/kontourai/flow-agents/commit/8bac9925007a0cee5015a87defb52d7bb5b994c5))
* **cli:** report the diagnostic a failing verb already composed, not its stack ([#1257](https://github.com/kontourai/flow-agents/issues/1257)) ([#1260](https://github.com/kontourai/flow-agents/issues/1260)) ([4f34314](https://github.com/kontourai/flow-agents/commit/4f343143767b1fce5d71ca09ed2bc2dd9534502a))
* **cli:** sidecar --key=value parser parity + option-level specs and allowlists ([#1294](https://github.com/kontourai/flow-agents/issues/1294)) ([#1303](https://github.com/kontourai/flow-agents/issues/1303)) ([df3e4ce](https://github.com/kontourai/flow-agents/commit/df3e4ce9d46ae44ba23e5adc96a0fc364dbe2e93))
* **evals:** MCP-on-PATH is a host property — skip with a note when absent, never fail the package ([#1311](https://github.com/kontourai/flow-agents/issues/1311)) ([8fcd57f](https://github.com/kontourai/flow-agents/commit/8fcd57f75fd17a62cbcbaac125f9f1e791979ac6))
* **init:** ignore the artifact root so the evidence writer can observe itself ([#1264](https://github.com/kontourai/flow-agents/issues/1264)) ([#1265](https://github.com/kontourai/flow-agents/issues/1265)) ([7f5669e](https://github.com/kontourai/flow-agents/commit/7f5669e7be1c6cee70225d56a35ba40215a404de))
* **init:** never overwrite what the bundle does not own — plan, preserve, disclose ([#1288](https://github.com/kontourai/flow-agents/issues/1288)) ([#1309](https://github.com/kontourai/flow-agents/issues/1309)) ([ee8d0d9](https://github.com/kontourai/flow-agents/commit/ee8d0d9853b94684b079aee299c55fdcbcc3e075))
* **merge-change:** derive start-definition proof; coordinator adopts the semantic route-map form ([#1307](https://github.com/kontourai/flow-agents/issues/1307)) ([#1308](https://github.com/kontourai/flow-agents/issues/1308)) ([17d6bf4](https://github.com/kontourai/flow-agents/commit/17d6bf4e523d7cee83d91870c60381ba69a428b1))
* **projection,schema:** review round 1 — printable digest input (raw NUL removed), contradiction-scope sentence ([#1266](https://github.com/kontourai/flow-agents/issues/1266) [#1267](https://github.com/kontourai/flow-agents/issues/1267)) ([3976662](https://github.com/kontourai/flow-agents/commit/39766625bd4819084a9d5eb510a462a2cf1dcf03))
* **sidecar:** the plan re-record IS the provenance-bearing criterion amendment channel ([#1312](https://github.com/kontourai/flow-agents/issues/1312)) ([#1313](https://github.com/kontourai/flow-agents/issues/1313)) ([15723f9](https://github.com/kontourai/flow-agents/commit/15723f945f4b9d04f9dfaf1efcc3c8d20e9a9c54))
* **telemetry:** count one API response once — transcript token totals were 2-3x inflated ([#1277](https://github.com/kontourai/flow-agents/issues/1277)) ([864b53d](https://github.com/kontourai/flow-agents/commit/864b53d64fbd1edf4a8ebe04227f35077edcb3ee))
* **telemetry:** report an absent host binding as absent, not as an invalid one ([#1278](https://github.com/kontourai/flow-agents/issues/1278)) ([002cc28](https://github.com/kontourai/flow-agents/commit/002cc281c4956510524215eb1c4dda5769a108ad)), closes [#1276](https://github.com/kontourai/flow-agents/issues/1276)
* **test:** descendant wait uses a 30s wall-clock deadline, not a 2s attempt budget ([#1259](https://github.com/kontourai/flow-agents/issues/1259)) ([#1270](https://github.com/kontourai/flow-agents/issues/1270)) ([8b27bd1](https://github.com/kontourai/flow-agents/commit/8b27bd1fe71cc6a19372012cb84fce3cd54508b7))
* **workflow:** freshness turnstile at cursor-advancing gates, enforced at the evaluation seam ([#1302](https://github.com/kontourai/flow-agents/issues/1302), [#1300](https://github.com/kontourai/flow-agents/issues/1300)) ([#1306](https://github.com/kontourai/flow-agents/issues/1306)) ([5b580d4](https://github.com/kontourai/flow-agents/commit/5b580d4e5c1ba59016e0f6831f824fbd47b35537))
* **workflow:** name every failing clause of the ensure-session ownership check ([#1297](https://github.com/kontourai/flow-agents/issues/1297)) ([dea2505](https://github.com/kontourai/flow-agents/commit/dea25050b5a310f9aedd68a9d742115ca9e346cb))

## [6.0.0](https://github.com/kontourai/flow-agents/compare/v5.10.0...v6.0.0) (2026-08-16)


### ⚠ BREAKING CHANGES

* **deps:** the operation-authority binding for publish-change evidence moves from a legacy `authority_trace` attachEvidence option (removed by Flow 5.0's option allowlist) to a claim-scoped `authorityRef` embedded in the attached TrustBundle's own `authorityTrace` array. Read-side authentication (hasCommittedPublishChangeRecoveryReceipt, merge-change.ts resultDigestClaimedByCanonicalRun) checks the new representation first and falls back to recognizing the legacy flat field for evidence attached by a long-running session before this upgrade. The flow-agents kit-config schema's `gate_overrides.*.expectations.*.authority_traces` field is renamed to `authority_refs` to match Flow 5.0's vocabulary; a committed Kit config still carrying the old name now fails closed with an actionable migration diagnostic instead of a bare schema rejection or a swallowed merge exception.

### Features

* **cli:** --authorize-backing-root for legacy Stow-shaped opencode uninstalls ([#1237](https://github.com/kontourai/flow-agents/issues/1237)) ([698db6a](https://github.com/kontourai/flow-agents/commit/698db6a19800b07de439a2165ad70412f4b6bd7b))
* **cli:** extend init --uninstall to codex and opencode through one shared manifest engine ([#1231](https://github.com/kontourai/flow-agents/issues/1231)) ([b6129fa](https://github.com/kontourai/flow-agents/commit/b6129faf5e6bf895172b51a73c99b6f6575a9022))
* **contract:** add monotonic delegation envelope ([#1112](https://github.com/kontourai/flow-agents/issues/1112)) ([#1241](https://github.com/kontourai/flow-agents/issues/1241)) ([b71e210](https://github.com/kontourai/flow-agents/commit/b71e2103c9441a551ebf7afe29230e5148a4a46c))
* **demo:** effectiveness loop — one command that installs, runs, measures, and reports ([#1251](https://github.com/kontourai/flow-agents/issues/1251)) ([6f90c66](https://github.com/kontourai/flow-agents/commit/6f90c6637d251792a2a58141721fe82b4b519acf))
* **economics:** production Stop hook emits the honest run-derived record ([#1254](https://github.com/kontourai/flow-agents/issues/1254)) ([389a8d9](https://github.com/kontourai/flow-agents/commit/389a8d9387e5e8640d8fd64b5377f83d83224b34))
* **kit:** activation lifecycle for built-in kits (active_kits registry, activate/deactivate verbs, steering respect) ([#1224](https://github.com/kontourai/flow-agents/issues/1224)) ([0accf19](https://github.com/kontourai/flow-agents/commit/0accf19e1b72365f6bf07df617c0023b75198ca5))
* **kit:** set-atomic multi-kit activate/deactivate with dependency ordering ([#1232](https://github.com/kontourai/flow-agents/issues/1232)) ([0177168](https://github.com/kontourai/flow-agents/commit/01771681fe27d5fff8471b937a0e8014a116d09d))
* **knowledge:** edge-preserving provider-graph ingest with ownership-guarded upsert ([#1218](https://github.com/kontourai/flow-agents/issues/1218)) ([95f2d08](https://github.com/kontourai/flow-agents/commit/95f2d089cceb28b9c15dc6d9f11056b36ce68847))
* **telemetry:** honest economics attribution derived from Flow run records ([#1227](https://github.com/kontourai/flow-agents/issues/1227)) ([553c634](https://github.com/kontourai/flow-agents/commit/553c634442b2328dd5b48c03b4e375268c8abaaf))


### Fixes

* bind command evidence to observed revisions ([#1230](https://github.com/kontourai/flow-agents/issues/1230)) ([20a9559](https://github.com/kontourai/flow-agents/commit/20a9559c2b79ca9b9730aa40c745d0ca17857192))
* **builder:** let a squash-equivalent reviewed tree satisfy critique descent ([#830](https://github.com/kontourai/flow-agents/issues/830)) ([#1243](https://github.com/kontourai/flow-agents/issues/1243)) ([4a87f0a](https://github.com/kontourai/flow-agents/commit/4a87f0a598e25d77de3608492da3baad6dfce427))
* **cli:** removal requires positive provenance ([#1238](https://github.com/kontourai/flow-agents/issues/1238)) ([#1240](https://github.com/kontourai/flow-agents/issues/1240)) ([85f29b4](https://github.com/kontourai/flow-agents/commit/85f29b4b0e8321425895269310f8fd3a8ab2ce27))
* **deps:** upgrade @kontourai/flow to 5.0.0 (integrity-fixed persistence, hardened evidence surface) ([#1220](https://github.com/kontourai/flow-agents/issues/1220)) ([fbcb772](https://github.com/kontourai/flow-agents/commit/fbcb772d9b19ce75f575abae401f823718fe4f5a))
* **sidecar:** let a committed manifest-declared CI command be claimable as tests-evidence ([#1048](https://github.com/kontourai/flow-agents/issues/1048)) ([#1245](https://github.com/kontourai/flow-agents/issues/1245)) ([05804b4](https://github.com/kontourai/flow-agents/commit/05804b47c66586861786c26ef72c7056830f0f84))


### Documentation

* **builder:** codify fault-injection sequencing and fix-round scope checking ([#1236](https://github.com/kontourai/flow-agents/issues/1236)) ([12d1749](https://github.com/kontourai/flow-agents/commit/12d17490590cad14c037f8a5aefc9e8bad4ae4f5))

## [5.10.0](https://github.com/kontourai/flow-agents/compare/v5.9.0...v5.10.0) (2026-08-08)


### Features

* **cli:** init --uninstall for claude-code with ownership manifest ([#1209](https://github.com/kontourai/flow-agents/issues/1209)) ([67d19d2](https://github.com/kontourai/flow-agents/commit/67d19d2ad722a56b4a6d3e0cbeaac66ba6ee54e2))
* **console:** receipt relay on the at-least-once class + eval console isolation ([#1087](https://github.com/kontourai/flow-agents/issues/1087) slice B, [#1094](https://github.com/kontourai/flow-agents/issues/1094) item C) ([#1096](https://github.com/kontourai/flow-agents/issues/1096)) ([33e12f3](https://github.com/kontourai/flow-agents/commit/33e12f3171f1bf1aa04572cc427b03834a8dafaa))
* **evals:** add opencode/pi/strands behavioral providers with builder flag ([#1203](https://github.com/kontourai/flow-agents/issues/1203)) ([21fda05](https://github.com/kontourai/flow-agents/commit/21fda0500ebb1a3c0a7114868feac0c87e1f4c4e))
* **telemetry:** stamp the durable economics record with install identity via a shared resolver ([#970](https://github.com/kontourai/flow-agents/issues/970)) ([#1188](https://github.com/kontourai/flow-agents/issues/1188)) ([d81df2b](https://github.com/kontourai/flow-agents/commit/d81df2bd4c60e1d0e35231600b46ba9100203e09))
* **transport:** at-least-once console delivery with a durable outbox ([#1087](https://github.com/kontourai/flow-agents/issues/1087) slice A) ([#1090](https://github.com/kontourai/flow-agents/issues/1090)) ([e84a4ce](https://github.com/kontourai/flow-agents/commit/e84a4cea7ca53ee40b58602d22565c5441f234e5))


### Fixes

* **cli:** emit the assignment-provider claim argv when a mutation lacks a matching actor ([#1194](https://github.com/kontourai/flow-agents/issues/1194)) ([#1202](https://github.com/kontourai/flow-agents/issues/1202)) ([c9bec5d](https://github.com/kontourai/flow-agents/commit/c9bec5dbb927443a3a887404127470aeae3805c6))
* **cli:** fail closed when hooks and sidecar writes target finished or advanced runs ([#1191](https://github.com/kontourai/flow-agents/issues/1191)) ([#1197](https://github.com/kontourai/flow-agents/issues/1197)) ([72771dd](https://github.com/kontourai/flow-agents/commit/72771dd0a8088d4ce865c4b66d5195f9a9a5297e))
* **cli:** transient-vs-domain failure taxonomy for hook and evidence writes ([#1192](https://github.com/kontourai/flow-agents/issues/1192)) ([#1204](https://github.com/kontourai/flow-agents/issues/1204)) ([bf70b39](https://github.com/kontourai/flow-agents/commit/bf70b3961257a5f35bc6c1c35f2935ae90801ec2))
* **knowledge:** Surface-schema-valid trust bundles, complete cache versioning, honest conditional-GET, coherent pull-work gates ([#1207](https://github.com/kontourai/flow-agents/issues/1207)) ([db1695c](https://github.com/kontourai/flow-agents/commit/db1695c4c206dbdcb1a210b58bc8851134662a25))
* require terminal delivery publication before merge ([#1034](https://github.com/kontourai/flow-agents/issues/1034)) ([e22b7a8](https://github.com/kontourai/flow-agents/commit/e22b7a874be68fda67985f5c8a65066c15f3134e))
* skip directory fsync on Windows in state-file-lock ([#1001](https://github.com/kontourai/flow-agents/issues/1001)) ([fa12229](https://github.com/kontourai/flow-agents/commit/fa12229214cad3025f4dff81f0411c030abfdf83))


### Documentation

* **decisions:** merge-readiness is an attestation, not a claim ([#1097](https://github.com/kontourai/flow-agents/issues/1097)) ([35b888b](https://github.com/kontourai/flow-agents/commit/35b888bd789418415bc96357628e28e06d314a18))

## [5.9.0](https://github.com/kontourai/flow-agents/compare/v5.8.0...v5.9.0) (2026-08-04)


### Features

* **hooks:** SessionStart install-freshness advisory — ancestry + registry signals, cache-as-untrusted-input ([#1180](https://github.com/kontourai/flow-agents/issues/1180) PR2) ([#1186](https://github.com/kontourai/flow-agents/issues/1186)) ([02c40e9](https://github.com/kontourai/flow-agents/commit/02c40e921bcb4232a9bff6252d398f4649b4a4c6))
* **telemetry:** install-identity join key — build-time stamp, pack-time truth assertion, labeled source enum ([#1180](https://github.com/kontourai/flow-agents/issues/1180) PR1) ([#1184](https://github.com/kontourai/flow-agents/issues/1184)) ([5042549](https://github.com/kontourai/flow-agents/commit/504254951c5e2ae29924731218af6e629b4d3eb4))

## [5.8.0](https://github.com/kontourai/flow-agents/compare/v5.7.0...v5.8.0) (2026-08-03)


### Features

* attest sealed execution provenance ([3dc29bf](https://github.com/kontourai/flow-agents/commit/3dc29bf2efad7cce15ece776da10ef37d5b41e87))
* **hooks:** advise on a Stop that changed tracked source without ever starting a session ([#1153](https://github.com/kontourai/flow-agents/issues/1153)) ([1d2d52e](https://github.com/kontourai/flow-agents/commit/1d2d52ecf34615c6d7bb486d8cce24505c011e2f))
* **knowledge:** standalone revision-bound Context Check ([#1158](https://github.com/kontourai/flow-agents/issues/1158)) ([d16e841](https://github.com/kontourai/flow-agents/commit/d16e841f78a3a349a259000a8e11658dd35cea98))


### Fixes

* **builder:** tolerate head-desynced gate claims backed by a current workspace snapshot ([#1170](https://github.com/kontourai/flow-agents/issues/1170) PR1) ([#1173](https://github.com/kontourai/flow-agents/issues/1173)) ([08714b6](https://github.com/kontourai/flow-agents/commit/08714b6d41eaead29cf4fafe0dfc2f4bd25401bd))
* **hooks:** deliver blocking Stop guidance to the model; graduated escalation by block class ([#1172](https://github.com/kontourai/flow-agents/issues/1172)) ([#1178](https://github.com/kontourai/flow-agents/issues/1178)) ([ac1edf4](https://github.com/kontourai/flow-agents/commit/ac1edf412092ee61bc09ee8fb7904e063899076a))
* **hooks:** surface tests-evidence scope divergence in the Stop backstop ([#1171](https://github.com/kontourai/flow-agents/issues/1171)) ([#1174](https://github.com/kontourai/flow-agents/issues/1174)) ([cdc7137](https://github.com/kontourai/flow-agents/commit/cdc7137f62e4ee1d13e382963c5955d0f3956737))
* **kit:** detect installed content drift ([#1159](https://github.com/kontourai/flow-agents/issues/1159)) ([4cc2fe3](https://github.com/kontourai/flow-agents/commit/4cc2fe3445791dbd71b3ec039affef138b2555d2))
* **kit:** make install registry portable ([#1163](https://github.com/kontourai/flow-agents/issues/1163)) ([0f8d4ff](https://github.com/kontourai/flow-agents/commit/0f8d4ffa7784d32c28f581a2156c3e16572a7ad5))
* **knowledge:** make installed evals and promote output portable ([#1166](https://github.com/kontourai/flow-agents/issues/1166)) ([4fab651](https://github.com/kontourai/flow-agents/commit/4fab651a6f74adf333a52f323d443f5a3bcfba41))
* **knowledge:** make vendored kit schemas self-contained ([#1165](https://github.com/kontourai/flow-agents/issues/1165)) ([e6dee8c](https://github.com/kontourai/flow-agents/commit/e6dee8c7ff4d36f781e5e13d2f85400e37412418))
* **sidecar:** stamp workspace snapshots at the producer for all gate claims ([#1170](https://github.com/kontourai/flow-agents/issues/1170) PR2) ([#1175](https://github.com/kontourai/flow-agents/issues/1175)) ([07bc688](https://github.com/kontourai/flow-agents/commit/07bc688fcf2d6901b7797ffdac801aa2813a996f))

## [5.7.0](https://github.com/kontourai/flow-agents/compare/v5.6.0...v5.7.0) (2026-08-02)


### Features

* add sealed evaluation lifecycle authority ([#1147](https://github.com/kontourai/flow-agents/issues/1147)) ([3f795f5](https://github.com/kontourai/flow-agents/commit/3f795f5b19cc84de1acce46e31772309a7d5d03c))
* **config:** add protected committed Kit policy ([#1138](https://github.com/kontourai/flow-agents/issues/1138)) ([80fff77](https://github.com/kontourai/flow-agents/commit/80fff770721051fe05975307068074e096299625))
* **flow:** compose multiple kit flows ([#1136](https://github.com/kontourai/flow-agents/issues/1136)) ([6bef2f4](https://github.com/kontourai/flow-agents/commit/6bef2f419a48d154a0e8d464505208f73d45caf2))


### Fixes

* export lifecycle result digest ([#1148](https://github.com/kontourai/flow-agents/issues/1148)) ([d5226fc](https://github.com/kontourai/flow-agents/commit/d5226fc483b5e629e147fb5ade124040a46ef1a0))
* expose minimal sealed execution surface ([#1149](https://github.com/kontourai/flow-agents/issues/1149)) ([ed8e79b](https://github.com/kontourai/flow-agents/commit/ed8e79b490b4e1c1a82459d01b3c126e74622fae))
* **workflow:** accept complete public evidence over planning placeholders ([#1128](https://github.com/kontourai/flow-agents/issues/1128)) ([56b6c02](https://github.com/kontourai/flow-agents/commit/56b6c02ad2e32bc500ebc0b009b4e6078663b2b1))
* **workflow:** admit coordinated receipt evidence ([#1150](https://github.com/kontourai/flow-agents/issues/1150)) ([618a79c](https://github.com/kontourai/flow-agents/commit/618a79c073118092fa1021001af444f76aa44e13))

## [5.6.0](https://github.com/kontourai/flow-agents/compare/v5.5.0...v5.6.0) (2026-08-01)


### Features

* add Kit observability contribution contract ([#1122](https://github.com/kontourai/flow-agents/issues/1122)) ([32c0939](https://github.com/kontourai/flow-agents/commit/32c0939ab2a4e81ac7514cd51c91d682907fab58))
* expose continuation adapter checkpoint identity ([#1076](https://github.com/kontourai/flow-agents/issues/1076)) ([7dd2a4f](https://github.com/kontourai/flow-agents/commit/7dd2a4f66bfd1240eb87cdcbb020c21a878f39dd))
* publish Trust advisory PR comments ([ce92236](https://github.com/kontourai/flow-agents/commit/ce9223697f16002bf345be93ccbe2e2183e028d9))
* surface Trust failure reasons ([90b2609](https://github.com/kontourai/flow-agents/commit/90b260996e1c4477c56317935f0362d48a8cf8d5))


### Fixes

* **ci:** reject a canonical verify command that pipes into another command ([#1089](https://github.com/kontourai/flow-agents/issues/1089)) ([95c77a8](https://github.com/kontourai/flow-agents/commit/95c77a833e7e76f6792b8de394feef6837d65af1))
* **hooks:** stop-gate must not double-gate an actor whose own next_action is done ([#962](https://github.com/kontourai/flow-agents/issues/962) P1) ([#1103](https://github.com/kontourai/flow-agents/issues/1103)) ([8bc1f4e](https://github.com/kontourai/flow-agents/commit/8bc1f4eab1f3ec0fb5e6460acc00dfabffd563bc))
* **opencode:** support Stow-managed global init ([#1117](https://github.com/kontourai/flow-agents/issues/1117)) ([ad75632](https://github.com/kontourai/flow-agents/commit/ad756327cbfae882fa4298513fc1027590e8895f))
* **telemetry-doctor:** resolve config the way the runtime does, not just the shipped default ([#1083](https://github.com/kontourai/flow-agents/issues/1083)) ([fe4add8](https://github.com/kontourai/flow-agents/commit/fe4add84f5a14d82531b56158aa5080c7d33f367))


### Documentation

* **decisions:** Console record delivery — delivery classes, and fold vs replay ([#1086](https://github.com/kontourai/flow-agents/issues/1086)) ([8d3fe3b](https://github.com/kontourai/flow-agents/commit/8d3fe3bf380184b248ae05c27f6c0b4ce392a74d))
* simplify trust advisory comments ([bb6cb97](https://github.com/kontourai/flow-agents/commit/bb6cb97cc46f7a64cefad7e1230e572bc37b9dd0))

## [5.5.0](https://github.com/kontourai/flow-agents/compare/v5.4.0...v5.5.0) (2026-07-28)


### Features

* **liveness:** add a fleet read surface over liveness lanes ([#1021](https://github.com/kontourai/flow-agents/issues/1021)) ([#1058](https://github.com/kontourai/flow-agents/issues/1058)) ([58c6bd3](https://github.com/kontourai/flow-agents/commit/58c6bd38f50794d4be9b66bdecb8a9a91e586616))


### Fixes

* **bundles:** ship codex's missing policy hooks, derive the JSON runtimes from one table ([#1024](https://github.com/kontourai/flow-agents/issues/1024)) ([#1026](https://github.com/kontourai/flow-agents/issues/1026)) ([d8dbba0](https://github.com/kontourai/flow-agents/commit/d8dbba0a16842b704ca4c6ce329de1ebce96f138))
* **ci:** install the Flow reducer closure from a lockfile so its pin is a control ([#1054](https://github.com/kontourai/flow-agents/issues/1054)) ([#1061](https://github.com/kontourai/flow-agents/issues/1061)) ([f512d63](https://github.com/kontourai/flow-agents/commit/f512d63bcdd253c96e1672ce8099adfbe34724b4))
* **hooks:** resolve protected paths instead of matching filename substrings ([#682](https://github.com/kontourai/flow-agents/issues/682)) ([#1004](https://github.com/kontourai/flow-agents/issues/1004)) ([78c90e4](https://github.com/kontourai/flow-agents/commit/78c90e4f025d422a36fa0e367a912260f73dd7f3))
* **liveness:** anchor a submodule on its own working tree, not .git/modules ([#1055](https://github.com/kontourai/flow-agents/issues/1055)) ([#1068](https://github.com/kontourai/flow-agents/issues/1068)) ([64564db](https://github.com/kontourai/flow-agents/commit/64564db90e0142da2154d3a8dba426e4313a341f))
* **liveness:** anchor lifecycle auto-emit on the shared repo root ([#1020](https://github.com/kontourai/flow-agents/issues/1020)) ([#1053](https://github.com/kontourai/flow-agents/issues/1053)) ([eb2099b](https://github.com/kontourai/flow-agents/commit/eb2099bf25f28b4773eb9e9f54f8d9845284793e))
* **trust:** make an unmatched delivery/DECLARED marker a distinguishable outcome ([#1011](https://github.com/kontourai/flow-agents/issues/1011)) ([#1015](https://github.com/kontourai/flow-agents/issues/1015)) ([e5f348b](https://github.com/kontourai/flow-agents/commit/e5f348b49f8130f9d452e73b104ba328f9916981))
* **workflow:** warn at record time when an evidence command cannot reconcile ([#1056](https://github.com/kontourai/flow-agents/issues/1056)) ([#1060](https://github.com/kontourai/flow-agents/issues/1060)) ([2feb899](https://github.com/kontourai/flow-agents/commit/2feb8990d420816cd695f009bb25b5fa7c6a5801))

## [5.4.0](https://github.com/kontourai/flow-agents/compare/v5.3.0...v5.4.0) (2026-07-26)


### Features

* add actor-bound host recovery ([#981](https://github.com/kontourai/flow-agents/issues/981)) ([5a3cc2a](https://github.com/kontourai/flow-agents/commit/5a3cc2aa3b1c8a3a489264d9d3d1442f3b3b8c92))
* add provisional delivery lifecycle ([#972](https://github.com/kontourai/flow-agents/issues/972)) ([ffbc15e](https://github.com/kontourai/flow-agents/commit/ffbc15e9d0fd9288a2e16cc5cc128ccb7835f04f))
* compile retrospective run observations ([#952](https://github.com/kontourai/flow-agents/issues/952)) ([f6de5a0](https://github.com/kontourai/flow-agents/commit/f6de5a020f30cf6e72ce3bba8a2fbf84974bb64b))
* compile retrospective usage corpus ([#968](https://github.com/kontourai/flow-agents/issues/968)) ([3a9affa](https://github.com/kontourai/flow-agents/commit/3a9affaa38ccbbabea61eab0261a72b36c59d180))
* correlate workflow outcome producers ([#941](https://github.com/kontourai/flow-agents/issues/941)) ([424b821](https://github.com/kontourai/flow-agents/commit/424b82129e3d1ffde5188c0e54579c9e1478e09d))
* **hooks:** a denied tool call ends the call, not the turn ([#1005](https://github.com/kontourai/flow-agents/issues/1005)) ([#1007](https://github.com/kontourai/flow-agents/issues/1007)) ([8da05ad](https://github.com/kontourai/flow-agents/commit/8da05ad3d36fb0d88d43712c183d324a5e611b02))
* **init:** bootstrap workflow providers ([#943](https://github.com/kontourai/flow-agents/issues/943)) ([1629e8b](https://github.com/kontourai/flow-agents/commit/1629e8bf80d10168101666f6970d48754879ff16))
* orchestrate mutable-resource flow cursors ([#965](https://github.com/kontourai/flow-agents/issues/965)) ([3f7f17f](https://github.com/kontourai/flow-agents/commit/3f7f17fa90cbd1d30056ae5defd7f4b9be4341dd))
* prepare canonical provider pickup ([#983](https://github.com/kontourai/flow-agents/issues/983)) ([e5820cd](https://github.com/kontourai/flow-agents/commit/e5820cd811dbcb6d3f5da433c2a6b79247701c70))
* **workflow:** persist signed continuation checkpoints ([#964](https://github.com/kontourai/flow-agents/issues/964)) ([4c00e16](https://github.com/kontourai/flow-agents/commit/4c00e169be3601eea1918ab69f7595aed1d36a6e))


### Fixes

* complete workflow evidence integrity recovery ([e821b6f](https://github.com/kontourai/flow-agents/commit/e821b6fa6785b3d3dcbf29aa18aede828daea7e9))
* constrain knowledge consolidation sources ([#969](https://github.com/kontourai/flow-agents/issues/969)) ([bcc6fe5](https://github.com/kontourai/flow-agents/commit/bcc6fe5e158e8be51d0bea1d8b7516ebb0743d30))
* **evidence:** execute evidence commands sequentially, not concurrently ([#974](https://github.com/kontourai/flow-agents/issues/974)) ([#976](https://github.com/kontourai/flow-agents/issues/976)) ([ae7699e](https://github.com/kontourai/flow-agents/commit/ae7699e0005b6f4d26c83dee912c7330311c5db7))
* make lifecycle static checks hermetic ([1c8c568](https://github.com/kontourai/flow-agents/commit/1c8c5680d6994b8f9f0e2537eeb46cd6c8a8a60a))
* make workflow evidence reseal atomic ([#932](https://github.com/kontourai/flow-agents/issues/932)) ([88f4fdc](https://github.com/kontourai/flow-agents/commit/88f4fdc8b723f0ad72a4faf27d6866fe03506404))
* patch production brace expansion ([#966](https://github.com/kontourai/flow-agents/issues/966)) ([43d6398](https://github.com/kontourai/flow-agents/commit/43d63984026f8979d71c9917dcac60ce84abe900))
* preserve Flow pending mutation tickets ([7976e24](https://github.com/kontourai/flow-agents/commit/7976e2473e2d949e8739deffa4048b67d6501089))
* preserve provider-confirmed workflow branches ([#956](https://github.com/kontourai/flow-agents/issues/956)) ([7cb7cb0](https://github.com/kontourai/flow-agents/commit/7cb7cb0e066f4f80a2734a2f31ae6dc5f15d678b))
* recover exact-current lifecycle completion ([#973](https://github.com/kontourai/flow-agents/issues/973)) ([a441e5d](https://github.com/kontourai/flow-agents/commit/a441e5d6e34acb7c18f34a55ce7d20584c93eb79))
* restore the release-please exemption after the bot identity changed ([#1010](https://github.com/kontourai/flow-agents/issues/1010)) ([67128f7](https://github.com/kontourai/flow-agents/commit/67128f77a3c1b11f433ae1d7933ce4bf704952f2))
* **trust:** accept unchanged terminal delivery companion ([#996](https://github.com/kontourai/flow-agents/issues/996)) ([fac32d0](https://github.com/kontourai/flow-agents/commit/fac32d0cf2be788bc1f3b51fc085c661a392a55b))
* use supported gh repository selectors ([#951](https://github.com/kontourai/flow-agents/issues/951)) ([a61130d](https://github.com/kontourai/flow-agents/commit/a61130db8d98f7760b005040f337b2832760b4ab))

## [5.3.0](https://github.com/kontourai/flow-agents/compare/v5.2.0...v5.3.0) (2026-07-24)


### Features

* add versioned run correlation envelope ([#869](https://github.com/kontourai/flow-agents/issues/869)) ([2bd9b10](https://github.com/kontourai/flow-agents/commit/2bd9b10b826d87c1293a3d7a38dfde3c38f179c0))
* **builder:** reclaim merged worktrees safely ([#910](https://github.com/kontourai/flow-agents/issues/910)) ([273c535](https://github.com/kontourai/flow-agents/commit/273c535d3efcfe79e0d1152f602ba949ecd298a5))
* **console:** project workflow trust bundles in Surface's shape ([#891](https://github.com/kontourai/flow-agents/issues/891)) ([#904](https://github.com/kontourai/flow-agents/issues/904)) ([375d323](https://github.com/kontourai/flow-agents/commit/375d323cb13e662e963798f5f7ba6fa050ef7c74))
* correlate installed runtime telemetry ([#936](https://github.com/kontourai/flow-agents/issues/936)) ([f430416](https://github.com/kontourai/flow-agents/commit/f4304168c4f215ea9fe98ad756cad80549841558))
* export workflow→console status mapping at ./console-contract ([#933](https://github.com/kontourai/flow-agents/issues/933)) ([#934](https://github.com/kontourai/flow-agents/issues/934)) ([8066c3c](https://github.com/kontourai/flow-agents/commit/8066c3c139a593e66eba0f0ef8258a67303afde2))
* harden correlated telemetry semantics ([#871](https://github.com/kontourai/flow-agents/issues/871)) ([7d474d6](https://github.com/kontourai/flow-agents/commit/7d474d6275b399e701838c07885135f6fe399107))
* mint canonical Builder run correlation ([#928](https://github.com/kontourai/flow-agents/issues/928)) ([0709651](https://github.com/kontourai/flow-agents/commit/0709651e42830f4506a06a39f26504d82de9e67d))
* propagate run correlation through Builder records ([#870](https://github.com/kontourai/flow-agents/issues/870)) ([f802c1c](https://github.com/kontourai/flow-agents/commit/f802c1c9180f6a8db2297d9bf07fe141f9a5109c))
* reconstruct correlated nested runs ([#872](https://github.com/kontourai/flow-agents/issues/872)) ([d4d4c8b](https://github.com/kontourai/flow-agents/commit/d4d4c8bded774e542680d3e3c9f22221d208de93))
* **telemetry:** hook-native console board sync + --skip-invalid projection flag ([#918](https://github.com/kontourai/flow-agents/issues/918), [#919](https://github.com/kontourai/flow-agents/issues/919)) ([#929](https://github.com/kontourai/flow-agents/issues/929)) ([14604fd](https://github.com/kontourai/flow-agents/commit/14604fdf4a1f8be8efad84f944d3db26002cf578))
* **workflow:** sign canonical gate projection ([#902](https://github.com/kontourai/flow-agents/issues/902)) ([da32dad](https://github.com/kontourai/flow-agents/commit/da32dad3e406a21a78d44dc7bc48130ed97df813))


### Fixes

* **builder:** keep execution skills out of control state ([#903](https://github.com/kontourai/flow-agents/issues/903)) ([3e62b86](https://github.com/kontourai/flow-agents/commit/3e62b8669404323c0a44d60a02888bc25bb26f51))
* check context-map drift before push ([#875](https://github.com/kontourai/flow-agents/issues/875)) ([522441e](https://github.com/kontourai/flow-agents/commit/522441e3ff8aa4ea41d9f2968126620af1f0f7ed))
* complete global opencode kit installs ([#880](https://github.com/kontourai/flow-agents/issues/880)) ([d4f6a30](https://github.com/kontourai/flow-agents/commit/d4f6a3054b560c951505bf860bba320d9f1dc463))
* **opencode:** target active worktree state ([#886](https://github.com/kontourai/flow-agents/issues/886)) ([9589af2](https://github.com/kontourai/flow-agents/commit/9589af2b89f715f151d548ce01aa4d12d55da8cb))
* quarantine malformed usage feedback sources ([#915](https://github.com/kontourai/flow-agents/issues/915)) ([650262e](https://github.com/kontourai/flow-agents/commit/650262ebabfbd36b7c6e27aa3ccb24c90890cf6a))
* separate joined usage feedback outcomes ([#921](https://github.com/kontourai/flow-agents/issues/921)) ([8dba326](https://github.com/kontourai/flow-agents/commit/8dba3268506b48f298263a9f44058b9734cb0a01))
* **workflow:** bind planned acceptance contract ([#899](https://github.com/kontourai/flow-agents/issues/899)) ([a5bf16a](https://github.com/kontourai/flow-agents/commit/a5bf16a7c8d1028c49330c41c8bc3402b329b047))
* **workflow:** preserve repeated critique rechecks ([#907](https://github.com/kontourai/flow-agents/issues/907)) ([334de0c](https://github.com/kontourai/flow-agents/commit/334de0c8b33d762f0a3169ccc0cadc5ebd50310c))

## [5.2.0](https://github.com/kontourai/flow-agents/compare/v5.1.0...v5.2.0) (2026-07-23)


### Features

* expose host actor workflow binding ([#863](https://github.com/kontourai/flow-agents/issues/863)) ([cd7f357](https://github.com/kontourai/flow-agents/commit/cd7f35777944d8d8419a8e436e0a1b988ed09be9))

## [5.1.0](https://github.com/kontourai/flow-agents/compare/v5.0.0...v5.1.0) (2026-07-23)


### Features

* dogfood portable host integration contracts ([a958b46](https://github.com/kontourai/flow-agents/commit/a958b46eaa63190fa59a2e1868f20afd41f1a791))
* dogfood portable host integration contracts ([#861](https://github.com/kontourai/flow-agents/issues/861)) ([8b993a6](https://github.com/kontourai/flow-agents/commit/8b993a6e076f212dec2093b9ff3daed9dbcd4968))


### Fixes

* **ci:** execute host conformance drift check ([870d25c](https://github.com/kontourai/flow-agents/commit/870d25c21af1feea39e95d588af209f9ed31bf40))

## [5.0.0](https://github.com/kontourai/flow-agents/compare/v4.8.0...v5.0.0) (2026-07-23)


### ⚠ BREAKING CHANGES

* delegate canonical review projection to Survey ([#859](https://github.com/kontourai/flow-agents/issues/859))
* Survey review-session resolvers now provide projectionSource and workflowSubjectRef instead of a caller-built surveyInput.

### Features

* delegate canonical review projection to Survey ([d707b9e](https://github.com/kontourai/flow-agents/commit/d707b9e7fd6ef2c5b6d242f636e33aec6ffef3c1))
* delegate canonical review projection to Survey ([#859](https://github.com/kontourai/flow-agents/issues/859)) ([28ddc75](https://github.com/kontourai/flow-agents/commit/28ddc75c08e3eefbe928c8a0f08d27b06049d819))

## [4.8.0](https://github.com/kontourai/flow-agents/compare/v4.7.0...v4.8.0) (2026-07-23)


### Features

* add survey flow gate adapter ([04c4128](https://github.com/kontourai/flow-agents/commit/04c41287e744b4822d04d307a224b8765d3361de))
* add survey flow gate adapter ([#856](https://github.com/kontourai/flow-agents/issues/856)) ([310b240](https://github.com/kontourai/flow-agents/commit/310b24032a8101b1501cb5bfa5f83c52d0a37664))
* bridge blocked gates to survey review work ([c30073c](https://github.com/kontourai/flow-agents/commit/c30073c06980a7c2cf9a7da3adaa75f87544ae2d))
* bridge blocked gates to survey review work ([#857](https://github.com/kontourai/flow-agents/issues/857)) ([7806259](https://github.com/kontourai/flow-agents/commit/7806259a6134f2b6545b882c0519981bd88a5b91))


### Fixes

* bind survey review projection authority ([cfc10eb](https://github.com/kontourai/flow-agents/commit/cfc10ebd69a2172a622c1ae45e0c9fd203427ef8))
* **contracts:** disambiguate work-item drift vocabularies instead of retiring one ([#818](https://github.com/kontourai/flow-agents/issues/818)) ([#853](https://github.com/kontourai/flow-agents/issues/853)) ([5e0d48f](https://github.com/kontourai/flow-agents/commit/5e0d48fa5011d1c95f739e32d886e9e4c1d8e38e))
* retain runtime dependency revision evidence ([ecd1d65](https://github.com/kontourai/flow-agents/commit/ecd1d65befb4b4f536b500bcd3d0e452302cda3f))

## [4.7.0](https://github.com/kontourai/flow-agents/compare/v4.6.2...v4.7.0) (2026-07-22)


### Features

* add portable utterance runtime profiles ([#850](https://github.com/kontourai/flow-agents/issues/850)) ([fb16cb5](https://github.com/kontourai/flow-agents/commit/fb16cb5b5a67455b90692f426e3306af87eab6b4))
* route utterance extraction through dispatch ([#848](https://github.com/kontourai/flow-agents/issues/848)) ([0761fd5](https://github.com/kontourai/flow-agents/commit/0761fd5c09430828c6894ecc7ea6d5d018dc22c3))


### Fixes

* **builder:** allow execute-to-plan correction for plan_gap ([#837](https://github.com/kontourai/flow-agents/issues/837)) ([07e65ae](https://github.com/kontourai/flow-agents/commit/07e65ae3fbc82d0b57defeecbadce71adafc3849))
* **builder:** ship standalone Flow validation ([efee110](https://github.com/kontourai/flow-agents/commit/efee110de5afce69b7bdd484aee3b9ed653b9914))

## [4.6.2](https://github.com/kontourai/flow-agents/compare/v4.6.1...v4.6.2) (2026-07-22)


### Fixes

* **ci:** require conventional pull request titles ([cf37e3d](https://github.com/kontourai/flow-agents/commit/cf37e3d3c31302057370b3cacbadd80188f51a52)), closes [#832](https://github.com/kontourai/flow-agents/issues/832)

## [4.6.1](https://github.com/kontourai/flow-agents/compare/v4.6.0...v4.6.1) (2026-07-22)


### Fixes

* **settings:** provider repo matchers accept dotted repository names ([#841](https://github.com/kontourai/flow-agents/issues/841)) ([92dd188](https://github.com/kontourai/flow-agents/commit/92dd18899c62e03bf81eaea67562f92e268f5e32)), closes [#840](https://github.com/kontourai/flow-agents/issues/840)


### Documentation

* publish reviewed grounding example ([#836](https://github.com/kontourai/flow-agents/issues/836)) ([f643a46](https://github.com/kontourai/flow-agents/commit/f643a464a5eb0c4b07fb89b23d7f30b70d55e7c9))
* **spec:** capture the orchestration-native capability set (issue [#86](https://github.com/kontourai/flow-agents/issues/86) decision) ([#835](https://github.com/kontourai/flow-agents/issues/835)) ([0806639](https://github.com/kontourai/flow-agents/commit/0806639ad91a46b1546e92afd18caf84dcc7d49b))

## [4.6.0](https://github.com/kontourai/flow-agents/compare/v4.5.0...v4.6.0) (2026-07-22)


### Features

* **providers:** importable TypeScript interfaces for the four provider roles ([#819](https://github.com/kontourai/flow-agents/issues/819)) ([11c70d7](https://github.com/kontourai/flow-agents/commit/11c70d7a101a2e490b85012f2a14266e4dea3ae4))
* **telemetry:** project workflow states onto Console's interactive process vocabulary ([#828](https://github.com/kontourai/flow-agents/issues/828)) ([6f47d1b](https://github.com/kontourai/flow-agents/commit/6f47d1b2e4f10281f8c74304760352b0a4f0c09a))


### Fixes

* **config-protection:** provably-read-only interpreter grammar for gate-file reads ([#799](https://github.com/kontourai/flow-agents/issues/799)) ([#822](https://github.com/kontourai/flow-agents/issues/822)) ([e933b17](https://github.com/kontourai/flow-agents/commit/e933b17ef9dfb421af3c40805850665bfc9baf57))
* **sidecar:** accept playwright test in the tests-evidence execution-proof screen ([#827](https://github.com/kontourai/flow-agents/issues/827)) ([435dd38](https://github.com/kontourai/flow-agents/commit/435dd384ccb4135e1a1f3e5cf398d5c09b046930))

## [4.5.0](https://github.com/kontourai/flow-agents/compare/v4.4.0...v4.5.0) (2026-07-21)


### Features

* **work-items:** provider-neutral mutation contract with conflict policy and two adapters ([#814](https://github.com/kontourai/flow-agents/issues/814)) ([df82ec4](https://github.com/kontourai/flow-agents/commit/df82ec4ab1a7875f19a5148286ecd4a4673d984c))


### Fixes

* **workflow:** keep learning outstanding loud — stop-gate flag, --skip-learning gap, unbound-session notice ([#793](https://github.com/kontourai/flow-agents/issues/793)) ([#798](https://github.com/kontourai/flow-agents/issues/798)) ([9d264a8](https://github.com/kontourai/flow-agents/commit/9d264a8ef105524d291366edd4bd063eacc599ba))

## [4.4.0](https://github.com/kontourai/flow-agents/compare/v4.3.1...v4.4.0) (2026-07-21)


### Features

* **protection:** scope gate-blocking to declared artifact roots; sanctioned fixture authoring ([#805](https://github.com/kontourai/flow-agents/issues/805)) ([999abfd](https://github.com/kontourai/flow-agents/commit/999abfd9c56c333b50b5e9618ba11ba17635a8c4))


### Fixes

* attest the reconciled delivery bundle ([#806](https://github.com/kontourai/flow-agents/issues/806)) ([0058671](https://github.com/kontourai/flow-agents/commit/00586711294462a1f935b67ca666811cfd525bdc))
* bind trust verification to consumer change context ([#806](https://github.com/kontourai/flow-agents/issues/806)) ([18da500](https://github.com/kontourai/flow-agents/commit/18da50059c87244cac4f117096270b54cbe85436))
* discover per-session trust bundles ([#810](https://github.com/kontourai/flow-agents/issues/810)) ([359b07c](https://github.com/kontourai/flow-agents/commit/359b07ce360af28caa7f462b4267665e9652eb8b))
* preserve bundle discovery ownership checks ([#806](https://github.com/kontourai/flow-agents/issues/806)) ([345591d](https://github.com/kontourai/flow-agents/commit/345591d92615e9ac4e46f106dd86b0260fb74e29))
* **trust:** separate advisory bundle absence policy ([07080df](https://github.com/kontourai/flow-agents/commit/07080df6be055c018902c26f2f298f16784ebfb4))

## [4.3.1](https://github.com/kontourai/flow-agents/compare/v4.3.0...v4.3.1) (2026-07-20)


### Fixes

* preserve critique predecessor chains in gate projection ([bb3d158](https://github.com/kontourai/flow-agents/commit/bb3d1580f3b09e38ebab42386308d00e659d3909))
* preserve critique predecessor chains in gate projection ([a0f780a](https://github.com/kontourai/flow-agents/commit/a0f780add3a5a570a2856b97360208a277a7be64))
* **sidecar:** loud publish-delivery preconditions and a help command ([#794](https://github.com/kontourai/flow-agents/issues/794)) ([a72d419](https://github.com/kontourai/flow-agents/commit/a72d4190b512f0315bed8966bb6788ef06fd6fa3))

## [4.3.0](https://github.com/kontourai/flow-agents/compare/v4.2.1...v4.3.0) (2026-07-20)


### Features

* add authenticated change provider execution ([9c05e64](https://github.com/kontourai/flow-agents/commit/9c05e64da650b1e98467ec86f9cf07983e3ca722))
* add authenticated change provider execution ([31a9783](https://github.com/kontourai/flow-agents/commit/31a9783f7dcb449b6f5d2158b31b0238cb685ba1))
* add critique resolution coordinator runtime ([9ff554d](https://github.com/kontourai/flow-agents/commit/9ff554d1a19752862c127d4ff32a3ec6cb5e082e))
* add lifecycle coordinator foundation ([caaa21f](https://github.com/kontourai/flow-agents/commit/caaa21ff2ad2fad99e45215da783e5155fe2591f))
* add reviewed grounding reference workflow ([7d6f7ef](https://github.com/kontourai/flow-agents/commit/7d6f7ef748ce58ce9b5e0b19779677c4f8f0fc04))
* authenticate cross-reviewer critique resolution ([8fee167](https://github.com/kontourai/flow-agents/commit/8fee1676d447dd0f51b1de2d36fc42a4ca6f885c))
* export canonical work-item vocabulary, types, and schemas subpath ([#792](https://github.com/kontourai/flow-agents/issues/792)) ([367cf73](https://github.com/kontourai/flow-agents/commit/367cf731e0cb33c509a2a31dce7bda39152fdc8a))
* pin lifecycle coordinator Flow reducer ([a360d2c](https://github.com/kontourai/flow-agents/commit/a360d2c8cab41a5a9d32f01d5743a55afa009f7f))
* provision privileged lifecycle authority ([650fcae](https://github.com/kontourai/flow-agents/commit/650fcaeaa5a53f773e43e08688bc2dc0bfd93f08))
* recover merged provider changes ([0fe4eec](https://github.com/kontourai/flow-agents/commit/0fe4eecfab8fcf7bc79ee9cfe26a33373457ab9c))
* resolve repaired critique history ([3f8bd3d](https://github.com/kontourai/flow-agents/commit/3f8bd3d608c7caaccb94245c2a0d2910b9130d01))
* track lifecycle authority trust roots ([07a8355](https://github.com/kontourai/flow-agents/commit/07a8355ab120f31bc5cac120155e0a74410b5c2a))


### Fixes

* allowlist provider execution environment ([11a4ae8](https://github.com/kontourai/flow-agents/commit/11a4ae864afd9f51d643ccc30d3ca6cde2a76060))
* authenticate critique resolution graph ([dd46e46](https://github.com/kontourai/flow-agents/commit/dd46e4659ce62b8610f243026b847c043106d590))
* authenticate recovery receipts end to end ([8f2f39b](https://github.com/kontourai/flow-agents/commit/8f2f39b10d072d4af6d47c24c5d5610c3644eecd))
* bind Builder gates to lifecycle attestations ([7c5ed31](https://github.com/kontourai/flow-agents/commit/7c5ed3127320fd363fe80ed0e40717534542ea5d))
* bind lifecycle recovery journals ([9d1b0d3](https://github.com/kontourai/flow-agents/commit/9d1b0d3aa5ebc30dae25a835926d7990106b6c02))
* bind provider config to trusted account context ([425d17a](https://github.com/kontourai/flow-agents/commit/425d17abe0615354bb36ccb091dbcab620ac95b8))
* bind provider execution to trusted identities ([a835ea4](https://github.com/kontourai/flow-agents/commit/a835ea4dafa3f60c94bf5b7a68cd06ef70ccbd3e))
* **builder:** ignore stale passing critiques at verify ([e325de3](https://github.com/kontourai/flow-agents/commit/e325de39edf9eca33e6570f521294f9263525587))
* **builder:** ignore stale passing critiques at verify ([d792d7c](https://github.com/kontourai/flow-agents/commit/d792d7ce46e23b9733515efd44cfc20fbe2b3759))
* close lifecycle authority trust gaps ([1f34eca](https://github.com/kontourai/flow-agents/commit/1f34eca420aa3c134c7cbbb8f2e6c7ec8cd3f22d))
* compose change provider with lifecycle authority ([3405093](https://github.com/kontourai/flow-agents/commit/3405093379094bdb82c89d13da092591ef94e51e))
* **evals:** make Goal Fit escape hatch identity-hermetic ([#736](https://github.com/kontourai/flow-agents/issues/736)) ([6cfb808](https://github.com/kontourai/flow-agents/commit/6cfb808ae7b6726ae0378aa9f7989a958a3ad478))
* expose node to lifecycle sudo helper ([d3d5fdc](https://github.com/kontourai/flow-agents/commit/d3d5fdcb640b81043d55b8db43194cd3d35a859b))
* externalize critique resolution trust anchor ([9c10e6d](https://github.com/kontourai/flow-agents/commit/9c10e6d541f2ba6261aab456525bad507c7e4a58))
* externalize lifecycle authority mutation ([a237d14](https://github.com/kontourai/flow-agents/commit/a237d14e61fc275ecd7d82ef8987b8507777cbd1))
* fail closed for nested review roots ([9835822](https://github.com/kontourai/flow-agents/commit/98358220e4ddb92e9bd768635d37c65c4a9b9bd4))
* harden authenticated change publication ([95dc168](https://github.com/kontourai/flow-agents/commit/95dc168e2c7286dc7e49858c83b62f8938e36a3e))
* harden authenticated critique resolution ([33c69c5](https://github.com/kontourai/flow-agents/commit/33c69c58a97e2156ea3e8923698adb98c0d61e46))
* harden critique resolution validation ([74c327f](https://github.com/kontourai/flow-agents/commit/74c327fe822ec206659f6b16eb48151ce935a431))
* harden lifecycle authority mutations ([ce8c764](https://github.com/kontourai/flow-agents/commit/ce8c764741f38fe32c03a5eab291e737ce88d35e))
* **installer:** trust canonical macOS temp aliases ([#747](https://github.com/kontourai/flow-agents/issues/747)) ([c8b40df](https://github.com/kontourai/flow-agents/commit/c8b40df37ca2ce4798057e871232ac648a6e0bc6))
* isolate lifecycle authority verification ([485fd78](https://github.com/kontourai/flow-agents/commit/485fd7867dc5a1f6074fd7a2324daafde015d9ec))
* isolate trusted command environments ([7cc475c](https://github.com/kontourai/flow-agents/commit/7cc475c8d2bb2d23d33a3e11fc7165cde6aeebc4))
* keep lifecycle authority writes external ([40001df](https://github.com/kontourai/flow-agents/commit/40001df5397076dc83374bf6bc32557aef21c6be))
* **kit:** make help side-effect-free ([#760](https://github.com/kontourai/flow-agents/issues/760)) ([12d2469](https://github.com/kontourai/flow-agents/commit/12d2469379e3d7ec08dfab4d6981b419be9b45d8))
* migrate and resolve multi-review history ([2747772](https://github.com/kontourai/flow-agents/commit/274777239edd3899d9c7763c5ede354a5b7d3947))
* normalize trusted environments across platforms ([15070b7](https://github.com/kontourai/flow-agents/commit/15070b76b006bc0e523786570f68ecce34339010))
* observe live provider telemetry ([19033f7](https://github.com/kontourai/flow-agents/commit/19033f76e959e5b3fdbf9eb602e58c7556b4fc1c))
* pin lifecycle authority protocol identity ([0059bf4](https://github.com/kontourai/flow-agents/commit/0059bf4f0c2ee6a8540fac5f46924c7069b84062))
* preserve critique bundle compatibility ([cf11f5a](https://github.com/kontourai/flow-agents/commit/cf11f5a21fff1a087309533634e8d3ac401cdcb2))
* preserve trusted Windows auth discovery ([6fc55b0](https://github.com/kontourai/flow-agents/commit/6fc55b0adfe16cb03b82d7c2cb032076f503a5ad))
* reauthenticate final provider observation ([5804a2e](https://github.com/kontourai/flow-agents/commit/5804a2eaee2a1004c03dd4e8f0453f5a182b82f9))
* reconcile lifecycle authority commits ([5ba3698](https://github.com/kontourai/flow-agents/commit/5ba36988daaa5e69a8f87973e8a5f7af8e1ad97d))
* refresh lifecycle dependency closure pin ([a8baf65](https://github.com/kontourai/flow-agents/commit/a8baf6504a2e08ce237ac0cf2cf24a64e38ca090))
* remove lifecycle authority test seam ([b29606e](https://github.com/kontourai/flow-agents/commit/b29606e2734a51d273115c8723980f8bfa2caf52))
* seal authenticated observation artifacts ([08ad48d](https://github.com/kontourai/flow-agents/commit/08ad48db595e7d2ccb2c943ecbf5143c9753434b))
* sign critique resolution authority ([ec10adb](https://github.com/kontourai/flow-agents/commit/ec10adb3b4382aa62fbb4788b8e710871f792e46))
* trust local git resolution for change publication ([fefae0e](https://github.com/kontourai/flow-agents/commit/fefae0ec0e2a448f87ad31bab58729f0d299d216))
* **trust-verify:** install action runtime dependencies ([#745](https://github.com/kontourai/flow-agents/issues/745)) ([f2efb33](https://github.com/kontourai/flow-agents/commit/f2efb33ef683793bbec01dcf7e909f3e1423c04d))
* verify lifecycle authority completions ([f7edbee](https://github.com/kontourai/flow-agents/commit/f7edbeeabad2ae0b168a7d7757406f35b93b72dd))
* verify signed critique event anchors ([1905135](https://github.com/kontourai/flow-agents/commit/1905135ff7a360a95f5c733451e552d423c8b850))
* yield during async subject lock contention ([ab9c737](https://github.com/kontourai/flow-agents/commit/ab9c73777c50d370b600810452a529bf36c23128))


### Documentation

* close governance kit migration contract ([#730](https://github.com/kontourai/flow-agents/issues/730)) ([77c61ec](https://github.com/kontourai/flow-agents/commit/77c61ec02257090b3304e07ea1ad0dd808c50be9))
* update Kontour UI package reference ([#728](https://github.com/kontourai/flow-agents/issues/728)) ([cc340af](https://github.com/kontourai/flow-agents/commit/cc340afd47ca0544ab2cfacd065ca76713dda6eb))

## [4.2.1](https://github.com/kontourai/flow-agents/compare/v4.2.0...v4.2.1) (2026-07-19)


### Fixes

* correlate Codex command results exactly ([#710](https://github.com/kontourai/flow-agents/issues/710)) ([089aca3](https://github.com/kontourai/flow-agents/commit/089aca32ecc41d637d770ae4b1b447956de0dc3f))
* restore clean npm installs ([#707](https://github.com/kontourai/flow-agents/issues/707)) ([2096acd](https://github.com/kontourai/flow-agents/commit/2096acddb6bf48db5dcad2a24f744b5b72022e73))
* scope critique freshness to gate visits ([#724](https://github.com/kontourai/flow-agents/issues/724)) ([d2dc723](https://github.com/kontourai/flow-agents/commit/d2dc723b73f27fa24e94604492dbb1fffc82af1d))

## [4.2.0](https://github.com/kontourai/flow-agents/compare/v4.1.0...v4.2.0) (2026-07-18)


### Features

* **liveness:** conf-driven console relay enablement ([#567](https://github.com/kontourai/flow-agents/issues/567)) + richer real-liveness signals ([#705](https://github.com/kontourai/flow-agents/issues/705)) ([b1dd5b0](https://github.com/kontourai/flow-agents/commit/b1dd5b081280d49c07d4e92ff2ffc5103dc89800))

## [4.1.0](https://github.com/kontourai/flow-agents/compare/v4.0.0...v4.1.0) (2026-07-18)


### Features

* **backlog:** board-based readiness source decision + surfaced fallback warnings ([#441](https://github.com/kontourai/flow-agents/issues/441)) ([#692](https://github.com/kontourai/flow-agents/issues/692)) ([8dc292d](https://github.com/kontourai/flow-agents/commit/8dc292d8df1e25373e603fe4d81a598aed063584))
* **ci:** enforce kits wrap the veritas engine via CLI, not as a library ([#651](https://github.com/kontourai/flow-agents/issues/651)) ([#701](https://github.com/kontourai/flow-agents/issues/701)) ([1fd0380](https://github.com/kontourai/flow-agents/commit/1fd0380ff0310d89db9c168d363a74c0df5aee04))
* **kit:** kit-provisioning primitive — declare files a kit scaffolds into a consumer repo ([#647](https://github.com/kontourai/flow-agents/issues/647)) ([#691](https://github.com/kontourai/flow-agents/issues/691)) ([a85bdad](https://github.com/kontourai/flow-agents/commit/a85bdad05676415cd9948b470b2d5cc079d5e6c7))
* **kits:** standing trigger-guards contract and agent_spawn_triggers validation warning ([#664](https://github.com/kontourai/flow-agents/issues/664)) ([#686](https://github.com/kontourai/flow-agents/issues/686)) ([ffcf0d9](https://github.com/kontourai/flow-agents/commit/ffcf0d98febc1815882c1586234806b831b90912))
* **veritas-governance:** consult-standards skill — JIT guidance via veritas explain (flow-agents[#649](https://github.com/kontourai/flow-agents/issues/649)) ([#700](https://github.com/kontourai/flow-agents/issues/700)) ([f1e8db2](https://github.com/kontourai/flow-agents/commit/f1e8db288b241e55b132be5a09dbfbdc4aaaa6b7))
* **veritas-governance:** provision governance git hooks (flow-agents[#648](https://github.com/kontourai/flow-agents/issues/648)) ([#699](https://github.com/kontourai/flow-agents/issues/699)) ([22965dd](https://github.com/kontourai/flow-agents/commit/22965ddeaf408ee9d5f8241cea60869a793a6495))
* **veritas-governance:** scaffold starter Repo Standards via kit provisions (flow-agents[#647](https://github.com/kontourai/flow-agents/issues/647)) ([#696](https://github.com/kontourai/flow-agents/issues/696)) ([6943362](https://github.com/kontourai/flow-agents/commit/6943362e39088682fabdbef032283041a3567411))
* **veritas-governance:** standards-authoring flow + skill ([#647](https://github.com/kontourai/flow-agents/issues/647)) ([#698](https://github.com/kontourai/flow-agents/issues/698)) ([6591a26](https://github.com/kontourai/flow-agents/commit/6591a268b8d16b41622c5203f4c97ca051170e29))
* **workflow:** machine-checkable wave-result reconciliation manifest ([#663](https://github.com/kontourai/flow-agents/issues/663) slice 1) ([#702](https://github.com/kontourai/flow-agents/issues/702)) ([282d2fd](https://github.com/kontourai/flow-agents/commit/282d2fdd28a941e6eb2d17fcd312d2f478f5e72d))


### Fixes

* **builder:** declare pr-open-gate route-back so missing_evidence repairs at verify ([#695](https://github.com/kontourai/flow-agents/issues/695) item a) ([#697](https://github.com/kontourai/flow-agents/issues/697)) ([d8b83df](https://github.com/kontourai/flow-agents/commit/d8b83dfd484828fadca3561bc51afdfd5d691f34))
* make workflow critique usable for single-orchestrator review ([#689](https://github.com/kontourai/flow-agents/issues/689), [#690](https://github.com/kontourai/flow-agents/issues/690)) ([#704](https://github.com/kontourai/flow-agents/issues/704)) ([a838b2e](https://github.com/kontourai/flow-agents/commit/a838b2e162e3bd31f6cc7314507f9bee7ac4ef5d))


### Documentation

* reconcile flow-agents docs to the veritas engine/kit split ([#652](https://github.com/kontourai/flow-agents/issues/652)) ([#703](https://github.com/kontourai/flow-agents/issues/703)) ([147b87a](https://github.com/kontourai/flow-agents/commit/147b87a3de14e8cc0d127e866c8136b60ab9b5b7))
* **veritas-governance:** point to the ratified engine/surface seam doc; refresh fixed veritas[#106](https://github.com/kontourai/flow-agents/issues/106) status ([#688](https://github.com/kontourai/flow-agents/issues/688)) ([14ba90d](https://github.com/kontourai/flow-agents/commit/14ba90db7ec844286479fc0a31af1ae5c1bc12ed))

## [4.0.0](https://github.com/kontourai/flow-agents/compare/v3.12.1...v4.0.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* gate-action envelopes now require schema 3.0 typed artifact targets and structured package-bound public interfaces.

### Features

* add check-hachure-boundary ratchet (layer-doctrine enforcement) ([#668](https://github.com/kontourai/flow-agents/issues/668)) ([803f427](https://github.com/kontourai/flow-agents/commit/803f42783ce1427339e18602c8fda5abad1e65c3))
* add mission-bound continuation context policy ([#639](https://github.com/kontourai/flow-agents/issues/639)) ([2a21810](https://github.com/kontourai/flow-agents/commit/2a218101ca97a10b88b205c86861fec40588d401))
* consume @kontourai/surface explainClaim; retire the local prototype ([#171](https://github.com/kontourai/flow-agents/issues/171)) ([#638](https://github.com/kontourai/flow-agents/issues/638)) ([d4da065](https://github.com/kontourai/flow-agents/commit/d4da065121a2438f9d63a481eee5b8c7c35d282d))
* **evals:** grounded narrative eval corpus, scorers, and mutation battery ([#612](https://github.com/kontourai/flow-agents/issues/612)) ([#667](https://github.com/kontourai/flow-agents/issues/667)) ([6cbb4ec](https://github.com/kontourai/flow-agents/commit/6cbb4ecd0a29183f47daf61939b97d7cebdaccb0))
* make gate actions executable and typed ([#627](https://github.com/kontourai/flow-agents/issues/627)) ([df0a4f4](https://github.com/kontourai/flow-agents/commit/df0a4f4140caef5a21cec24ad5aea97802dcff88))
* migrate InquiryRecord validation from raw hachure to Surface ([#674](https://github.com/kontourai/flow-agents/issues/674)) ([7d91e90](https://github.com/kontourai/flow-agents/commit/7d91e90273718b39d9b788540788349f1be8155e))
* **narrative:** bounded at-action agent_stated intent annotation + fallback ([#622](https://github.com/kontourai/flow-agents/issues/622)) ([#665](https://github.com/kontourai/flow-agents/issues/665)) ([aac2dea](https://github.com/kontourai/flow-agents/commit/aac2dea06d182922a48bb0a106ea250103486e97))
* **narrative:** deterministic grounding validator — fail-closed publication gate ([#623](https://github.com/kontourai/flow-agents/issues/623)) ([#654](https://github.com/kontourai/flow-agents/issues/654)) ([b6d5148](https://github.com/kontourai/flow-agents/commit/b6d514855d5a960fc9b6b043951dee515c289552))
* **narrative:** grounded runtime projection — turn spine, atomic statements, throw-don't-omit coverage ([#618](https://github.com/kontourai/flow-agents/issues/618)) ([#642](https://github.com/kontourai/flow-agents/issues/642)) ([3dfcb52](https://github.com/kontourai/flow-agents/commit/3dfcb520b0e999effe98390f6c114deb4023eb64))
* **narrative:** grounded-execution-narrative/v1 — deterministic composition over authority-owned projections ([#613](https://github.com/kontourai/flow-agents/issues/613)) ([#645](https://github.com/kontourai/flow-agents/issues/645)) ([840d8a9](https://github.com/kontourai/flow-agents/commit/840d8a95d7d30838cdd534ecaca7883d1ac5b19a))
* **narrative:** model-assisted prose renderer — display-only, fail-closed ([#614](https://github.com/kontourai/flow-agents/issues/614)) ([#655](https://github.com/kontourai/flow-agents/issues/655)) ([f8d67c9](https://github.com/kontourai/flow-agents/commit/f8d67c98b2891eee0d301da8145ea64b312b152d))
* **narrative:** source contract — frozen manifest, snapshot-at-compile, integrity classes, resolver ([#617](https://github.com/kontourai/flow-agents/issues/617)) ([#632](https://github.com/kontourai/flow-agents/issues/632)) ([e09ee0e](https://github.com/kontourai/flow-agents/commit/e09ee0ebf0d39c3eeb694a480842be6dd2068a29))
* **narrative:** trust isolation — namespace, canonical+content-shape evidence guards, negative-test battery ([#619](https://github.com/kontourai/flow-agents/issues/619)) ([#653](https://github.com/kontourai/flow-agents/issues/653)) ([90535c5](https://github.com/kontourai/flow-agents/commit/90535c5b33295f9aabab59cdd3731dced07ea3c8))
* **telemetry:** delegationTarget on tool events + Codex-CLI detection ([#581](https://github.com/kontourai/flow-agents/issues/581)) ([#676](https://github.com/kontourai/flow-agents/issues/676)) ([bb38be0](https://github.com/kontourai/flow-agents/commit/bb38be07238bcd8ed313e6958b9ba96a2e67ef45))
* **telemetry:** durationMs / outcome / status per tool result ([#580](https://github.com/kontourai/flow-agents/issues/580)) ([#675](https://github.com/kontourai/flow-agents/issues/675)) ([6892ae0](https://github.com/kontourai/flow-agents/commit/6892ae0e0495bedb369238197b05d847284c4089))
* **telemetry:** normalized action-class ontology on tool events ([#582](https://github.com/kontourai/flow-agents/issues/582)) ([#678](https://github.com/kontourai/flow-agents/issues/678)) ([3d7422c](https://github.com/kontourai/flow-agents/commit/3d7422ce7b7d0a10d54426c861ff22a37728d17a))
* **trust:** writer-observed execution in the command log ([#634](https://github.com/kontourai/flow-agents/issues/634)) ([#636](https://github.com/kontourai/flow-agents/issues/636)) ([3352895](https://github.com/kontourai/flow-agents/commit/3352895855172801ec29a2717f67cc00909ea29c))


### Fixes

* bind workflow guidance to canonical flow state ([d73eb69](https://github.com/kontourai/flow-agents/commit/d73eb695c4744ee58029ec1b4a89b0b585c3872a))
* bind workflow guidance to canonical Flow state ([814f4a2](https://github.com/kontourai/flow-agents/commit/814f4a284aa015de1fb2e689fac8fa29df23ccaa))
* constrain continuation repair to issued gate ([876851d](https://github.com/kontourai/flow-agents/commit/876851d95756bf7131643a7db5b344b7eb4ce733))
* constrain continuation repair to issued gate ([05de903](https://github.com/kontourai/flow-agents/commit/05de90331d2092af25d854ce5be526749027d928))
* expose gate-action artifact expectation bindings ([#629](https://github.com/kontourai/flow-agents/issues/629)) ([721905d](https://github.com/kontourai/flow-agents/commit/721905d9135622928b3f8c4bbe7910d1d3c4a47e))
* preserve acceptance claim integrity across gates ([#633](https://github.com/kontourai/flow-agents/issues/633)) ([81da744](https://github.com/kontourai/flow-agents/commit/81da744107d3f5bec4e6d82fa992c76c34c24ec9))
* preserve optional artifact bindings ([#631](https://github.com/kontourai/flow-agents/issues/631)) ([00e75b6](https://github.com/kontourai/flow-agents/commit/00e75b6f76854197aa8e59a4b532e7f09797d4e4))
* return signed continuation turns to driver ([#635](https://github.com/kontourai/flow-agents/issues/635)) ([acf09c9](https://github.com/kontourai/flow-agents/commit/acf09c9780d5e70f594c4f6c4dc6f4b9405f96c0))
* suppress terminal workflow actions ([9e78243](https://github.com/kontourai/flow-agents/commit/9e7824326577761b85be802448bd87b27e6ede9f))
* **telemetry:** fail CLOSED on console-relay usage sanitize ([#568](https://github.com/kontourai/flow-agents/issues/568) follow-up) ([#666](https://github.com/kontourai/flow-agents/issues/666)) ([2f46d49](https://github.com/kontourai/flow-agents/commit/2f46d491e29fd0e3b6c494a0889202890dbf314b))

## [3.12.1](https://github.com/kontourai/flow-agents/compare/v3.12.0...v3.12.1) (2026-07-13)


### Fixes

* bind gate-action requirements to gates ([#608](https://github.com/kontourai/flow-agents/issues/608)) ([b1e9ad1](https://github.com/kontourai/flow-agents/commit/b1e9ad1a03ba1b88e09d6ace156e33c010bc6848))

## [3.12.0](https://github.com/kontourai/flow-agents/compare/v3.11.0...v3.12.0) (2026-07-13)


### Features

* add canonical gate action envelopes ([#605](https://github.com/kontourai/flow-agents/issues/605)) ([a7cc3e5](https://github.com/kontourai/flow-agents/commit/a7cc3e553bf03ec47a008424c3d2f7693432286b))

## [3.11.0](https://github.com/kontourai/flow-agents/compare/v3.10.0...v3.11.0) (2026-07-13)


### Features

* sign continuation adapter evidence ([#598](https://github.com/kontourai/flow-agents/issues/598)) ([df14271](https://github.com/kontourai/flow-agents/commit/df14271a64c4de069dc47f5b3c18729caa025bbb))


### Fixes

* make Codex installs self-contained and bind GitHub claims ([#600](https://github.com/kontourai/flow-agents/issues/600)) ([57d1942](https://github.com/kontourai/flow-agents/commit/57d1942a5a8b3d005f1f91d778de385d924518bd))

## [3.10.0](https://github.com/kontourai/flow-agents/compare/v3.9.0...v3.10.0) (2026-07-13)


### Features

* **telemetry:** per-turn model/tokens/cost on tool events ([#568](https://github.com/kontourai/flow-agents/issues/568) slice 1) ([80ac0e7](https://github.com/kontourai/flow-agents/commit/80ac0e73a524fb1f84f0bffac94fe78ce4883b74))
* **telemetry:** per-turn model/tokens/cost on tool events ([#568](https://github.com/kontourai/flow-agents/issues/568) slice 1) ([2b6276d](https://github.com/kontourai/flow-agents/commit/2b6276d42b30123a61b3d9a9181ebd77affc0e70))


### Fixes

* **#440:** scope ownership signals to the actor's own per-actor pointer ([#586](https://github.com/kontourai/flow-agents/issues/586)) ([7a8fc82](https://github.com/kontourai/flow-agents/commit/7a8fc82f22201fd916631beff6bb85fe288d461e))
* **liveness:** identify Codex actors by thread ([#556](https://github.com/kontourai/flow-agents/issues/556)) ([5ac02cb](https://github.com/kontourai/flow-agents/commit/5ac02cbc6f374d0b75bc03c4230f6d255568693a))
* **packaging:** preserve runtime instruction files ([#575](https://github.com/kontourai/flow-agents/issues/575)) ([f55d288](https://github.com/kontourai/flow-agents/commit/f55d28839bf87f35aaecb5a7aae0ba7fe55f51c7))
* **packaging:** stop seeding Codex global instructions ([#573](https://github.com/kontourai/flow-agents/issues/573)) ([2d25cb6](https://github.com/kontourai/flow-agents/commit/2d25cb65af2b5403a164a645ae615e2388681640))
* resolve continuation validator from installed runtime ([#591](https://github.com/kontourai/flow-agents/issues/591)) ([86191c4](https://github.com/kontourai/flow-agents/commit/86191c4e39abcb3123b8823f4604ca7183d0be83))

## [3.9.0](https://github.com/kontourai/flow-agents/compare/v3.8.0...v3.9.0) (2026-07-12)


### Features

* **workflow:** add bounded continuation driver ([#560](https://github.com/kontourai/flow-agents/issues/560)) ([e6365ab](https://github.com/kontourai/flow-agents/commit/e6365aba324c76ee164681c987d20916c315444e))

## [3.8.0](https://github.com/kontourai/flow-agents/compare/v3.7.0...v3.8.0) (2026-07-12)


### Features

* **packaging:** install portable skills under .agents ([#551](https://github.com/kontourai/flow-agents/issues/551)) ([12f12e3](https://github.com/kontourai/flow-agents/commit/12f12e3d0a32b398e47a9ac01604179c58bf14ba))


### Fixes

* **builder:** make gate evidence sync visit-safe ([#558](https://github.com/kontourai/flow-agents/issues/558)) ([1c0e8dc](https://github.com/kontourai/flow-agents/commit/1c0e8dcea6bdfd7d54484f950b2432fcf727b0ea))

## [3.7.0](https://github.com/kontourai/flow-agents/compare/v3.6.0...v3.7.0) (2026-07-12)


### Features

* **builder:** align kit skills with canonical Flow ([#552](https://github.com/kontourai/flow-agents/issues/552)) ([2d672ed](https://github.com/kontourai/flow-agents/commit/2d672ede2dc16f96ef2d5186a3f0b6fc1c9d162f))

## [3.6.0](https://github.com/kontourai/flow-agents/compare/v3.5.0...v3.6.0) (2026-07-11)


### Features

* **builder:** add authority-aware lifecycle controls ([#546](https://github.com/kontourai/flow-agents/issues/546)) ([5164902](https://github.com/kontourai/flow-agents/commit/51649020bc9a90dd77907f2aabdd9fb593f43504))
* **cli:** add public workflow command ([#548](https://github.com/kontourai/flow-agents/issues/548)) ([2dad479](https://github.com/kontourai/flow-agents/commit/2dad47974819100ecb850fa0bec645e911d168f8))

## [3.5.0](https://github.com/kontourai/flow-agents/compare/v3.4.3...v3.5.0) (2026-07-10)


### Features

* **builder:** derive selected-work evidence from acquisition ([#543](https://github.com/kontourai/flow-agents/issues/543)) ([bfe1681](https://github.com/kontourai/flow-agents/commit/bfe1681211174cb6219b0dd94d765aa9c99734bd))

## [3.4.3](https://github.com/kontourai/flow-agents/compare/v3.4.2...v3.4.3) (2026-07-10)


### Fixes

* start Builder Flow during session creation ([#539](https://github.com/kontourai/flow-agents/issues/539)) ([10214b4](https://github.com/kontourai/flow-agents/commit/10214b478530e522f0dc50c24175d1516c113431))

## [3.4.2](https://github.com/kontourai/flow-agents/compare/v3.4.1...v3.4.2) (2026-07-10)


### Fixes

* enforce canonical Builder entry action ([#536](https://github.com/kontourai/flow-agents/issues/536)) ([bab5dfe](https://github.com/kontourai/flow-agents/commit/bab5dfe419a42b137dcb79bd276edf3268c5fb23))

## [3.4.1](https://github.com/kontourai/flow-agents/compare/v3.4.0...v3.4.1) (2026-07-10)


### Fixes

* resolve packaged Flow definitions in consumer repos ([#532](https://github.com/kontourai/flow-agents/issues/532)) ([3eb4a2e](https://github.com/kontourai/flow-agents/commit/3eb4a2e42d49a9c31b16ef62484cf5b0a001c7a1))

## [3.4.0](https://github.com/kontourai/flow-agents/compare/v3.3.0...v3.4.0) (2026-07-10)


### Features

* **builder:** add fail-closed FlowRun adapter prefix ([#511](https://github.com/kontourai/flow-agents/issues/511)) ([1f2a1bd](https://github.com/kontourai/flow-agents/commit/1f2a1bd0a6a6f1b5610848b417ed8c9561b85131))
* **builder:** route Codex specialists by role ([5a53e9b](https://github.com/kontourai/flow-agents/commit/5a53e9bb79afbba6823c7c1de77125030d87dc41))
* drive Builder sessions with canonical Flow runs ([#531](https://github.com/kontourai/flow-agents/issues/531)) ([72301c7](https://github.com/kontourai/flow-agents/commit/72301c735d3788283ffe40963ee7fc622f69e822))
* **engine:** collapse kit trust model to structured steering (kit-neutral) ([#491](https://github.com/kontourai/flow-agents/issues/491)) ([615dc44](https://github.com/kontourai/flow-agents/commit/615dc4477f884e8ad61f37ea67fc250a3a3030ec))
* installed-skill drift detection — per-skill manifest, skill-drift-check CLI, SessionStart advisory ([#439](https://github.com/kontourai/flow-agents/issues/439)) ([#455](https://github.com/kontourai/flow-agents/issues/455)) ([a23c346](https://github.com/kontourai/flow-agents/commit/a23c34673e41bc8dcb8fd0c72425ac5ae83f4247))
* **install:** guided console-connect wizard + auto-verify + post-install summary (easy-install-flow PR2/3) ([#483](https://github.com/kontourai/flow-agents/issues/483)) ([573fd81](https://github.com/kontourai/flow-agents/commit/573fd81860de9731ebe76f352da8502137159bb7))
* **install:** runtime auto-detection + surface silent fail-open paths (easy-install-flow PR1/3) ([#482](https://github.com/kontourai/flow-agents/issues/482)) ([a9d249e](https://github.com/kontourai/flow-agents/commit/a9d249ee1b5104488ead521dbd012e5cc8240b6c))
* **learning-review:** economics-driven advisory proposals + human-ratified decision ledger ([#352](https://github.com/kontourai/flow-agents/issues/352)) ([#464](https://github.com/kontourai/flow-agents/issues/464)) ([1f8e56b](https://github.com/kontourai/flow-agents/commit/1f8e56bba2a71e77e43e42dc2574101e40399adc))
* **telemetry:** auto-discover owner console conf via trusted workspace/global tiers (fa[#410](https://github.com/kontourai/flow-agents/issues/410) slice 1) ([#460](https://github.com/kontourai/flow-agents/issues/460)) ([4f82858](https://github.com/kontourai/flow-agents/commit/4f828589dc70d6a25bfa609961968833106d58e4))
* **telemetry:** config-driven kit-economics console relay so ROI views populate ([#469](https://github.com/kontourai/flow-agents/issues/469)) ([#471](https://github.com/kontourai/flow-agents/issues/471)) ([f604f60](https://github.com/kontourai/flow-agents/commit/f604f609924635ea53ac051b822ee068504f59fb))
* **veritas-governance:** exemption-usage-review skill, trailer diagnostic, DECLARED scope-forms docs ([#408](https://github.com/kontourai/flow-agents/issues/408)) ([d304621](https://github.com/kontourai/flow-agents/commit/d304621d744f84cd422ca069183f41826c2c1b20))


### Fixes

* **checks:** content-boundary scans untracked files — local matches CI (closes [#367](https://github.com/kontourai/flow-agents/issues/367)) ([#374](https://github.com/kontourai/flow-agents/issues/374)) ([a4e7a0e](https://github.com/kontourai/flow-agents/commit/a4e7a0ef8341ab951597ef6255e4b66f315f8f2c))
* codex capture false-pass — deterministic exit codes, ambiguous default, anti-forgery extraction ([2806c5b](https://github.com/kontourai/flow-agents/commit/2806c5bb7c39e376937162ab0680c01f4fc80666))
* codex capture false-pass — deterministic exit codes, ambiguous default, anti-forgery extraction ([#470](https://github.com/kontourai/flow-agents/issues/470)) ([06c292a](https://github.com/kontourai/flow-agents/commit/06c292a6ccfface4d778f78ec2e04ba2dd801daa))
* enforce first-step workflow entry ([17b3a12](https://github.com/kontourai/flow-agents/commit/17b3a1282f491cd2c655b0da9847c00925f18ef8))
* **goal-fit:** stop re-running model-asserted RECHECK text on terminal sessions ([#494](https://github.com/kontourai/flow-agents/issues/494)) ([#504](https://github.com/kontourai/flow-agents/issues/504)) ([9546252](https://github.com/kontourai/flow-agents/commit/954625233dddd14772b57ecba98016a911443f4d))
* harden global Codex home installs ([1bfaba6](https://github.com/kontourai/flow-agents/commit/1bfaba65a3b490d0b031401268c55b8d74f930b7))
* preserve user installer settings conflicts ([#430](https://github.com/kontourai/flow-agents/issues/430)) ([ac2d356](https://github.com/kontourai/flow-agents/commit/ac2d3567f47a744c7c5466d60aec26577f846a31))
* **sidecar:** trust-bundle writers compose losslessly; record-check; record-time evidence-ref validation ([#418](https://github.com/kontourai/flow-agents/issues/418)) ([800675f](https://github.com/kontourai/flow-agents/commit/800675f75033a164c24e2be379dc2b41c76d2237))
* skill-drift-check ignores foreign (non-kit) installed files ([#465](https://github.com/kontourai/flow-agents/issues/465)) ([#468](https://github.com/kontourai/flow-agents/issues/468)) ([71985c9](https://github.com/kontourai/flow-agents/commit/71985c9c8f860a50b25f1bec3818af9807832cae))
* **telemetry:** land owner usage attributed + priced in the hosted console ([#487](https://github.com/kontourai/flow-agents/issues/487)) ([ace8faf](https://github.com/kontourai/flow-agents/commit/ace8fafc2af274302397c1e12bb09388db5fe0e9))
* **telemetry:** real per-session token/cost + model so console ROI stops showing $0 ([#477](https://github.com/kontourai/flow-agents/issues/477)) ([2a6fcfc](https://github.com/kontourai/flow-agents/commit/2a6fcfc5d18acaddcb64eabc4341e10d2c9d7184))
* **telemetry:** suppress console relay of genuinely-empty economics records ([#478](https://github.com/kontourai/flow-agents/issues/478)) ([b09b6de](https://github.com/kontourai/flow-agents/commit/b09b6de189f6bef051c25fbb6c52dd61919d9c62))


### Documentation

* **console:** document attribution & pricing correctness ([#487](https://github.com/kontourai/flow-agents/issues/487)) ([#490](https://github.com/kontourai/flow-agents/issues/490)) ([36b0ec2](https://github.com/kontourai/flow-agents/commit/36b0ec288b3aea6ca49efaaa2373ea9b60a55197))
* **decisions:** embeddable engine and adapter model direction ([#499](https://github.com/kontourai/flow-agents/issues/499)) ([89aec1d](https://github.com/kontourai/flow-agents/commit/89aec1df53df27cfa85685bc24612edf0882cb5c))
* **engine:** reframe around engine↔kit split + honest trust tiers ([#495](https://github.com/kontourai/flow-agents/issues/495)) ([b5b5ae3](https://github.com/kontourai/flow-agents/commit/b5b5ae392cd43ee2e0374b5b08da40add5c06c3a))
* trust-reconciliation guide + trust-ledger-retention decision ([#488](https://github.com/kontourai/flow-agents/issues/488)) ([9d5feba](https://github.com/kontourai/flow-agents/commit/9d5febae318e62bb59189279321d92f4ede3afa2))

## [3.3.0](https://github.com/kontourai/flow-agents/compare/v3.2.0...v3.3.0) (2026-07-05)


### Features

* **cleanup-audit:** apply mode — safe, reversible session archival ([#406](https://github.com/kontourai/flow-agents/issues/406)) ([3dd7550](https://github.com/kontourai/flow-agents/commit/3dd7550a664c01ee5afb6eabb75325a02de28b59))
* **veritas-governance:** exemption-issuance flow — governed path for delivery/DECLARED (ADR 0022 §3) ([#370](https://github.com/kontourai/flow-agents/issues/370)) ([50f8f3b](https://github.com/kontourai/flow-agents/commit/50f8f3b0aa65a7b18c6d736360e93f43bb057145))


### Documentation

* unified coordination guide + console integration doc + status hygiene ([#399](https://github.com/kontourai/flow-agents/issues/399)) ([#400](https://github.com/kontourai/flow-agents/issues/400)) ([b60331e](https://github.com/kontourai/flow-agents/commit/b60331e1b10d3a417a941de836bbac01bee490bc))

## [3.2.0](https://github.com/kontourai/flow-agents/compare/v3.1.0...v3.2.0) (2026-07-04)


### Features

* **builder:** per-step model-routing hints + escalate-on-gate-failure ladder ([#376](https://github.com/kontourai/flow-agents/issues/376)) ([8182dc6](https://github.com/kontourai/flow-agents/commit/8182dc66da10f3bfd731aef93d7cbd38b63ddd06))
* **knowledge:** inbound-reference integrity check, fail closed ([#340](https://github.com/kontourai/flow-agents/issues/340)) ([02932ab](https://github.com/kontourai/flow-agents/commit/02932abec98fcc43ae3755d2281697e21c7451a6))
* **knowledge:** incremental append-mode consolidate (Closes [#343](https://github.com/kontourai/flow-agents/issues/343)) ([9b972f5](https://github.com/kontourai/flow-agents/commit/9b972f5bf9d7a41d1de4af23d5e27619db3b1635))
* **knowledge:** incremental append-mode consolidate, regenerate snapshot from records ([#343](https://github.com/kontourai/flow-agents/issues/343)) ([32cc263](https://github.com/kontourai/flow-agents/commit/32cc263aedc4c3727b144ced24872bc102a13383))
* **knowledge:** record-carried freshness + Hachure-aligned status semantics ([#341](https://github.com/kontourai/flow-agents/issues/341)) ([32ff45e](https://github.com/kontourai/flow-agents/commit/32ff45eb9244fa1879a0b32784e95e5e5c80de71))


### Fixes

* **delivery:** per-session delivery paths so concurrent deliveries stop contending ([#379](https://github.com/kontourai/flow-agents/issues/379)) ([fedf4db](https://github.com/kontourai/flow-agents/commit/fedf4db5c41c7e45dcf9db949176be076131a09e))
* **delivery:** per-session delivery paths so concurrent deliveries stop contending ([#379](https://github.com/kontourai/flow-agents/issues/379)) ([a03026f](https://github.com/kontourai/flow-agents/commit/a03026fccf940da2129a3b82e979443c37b87456))

## [3.1.0](https://github.com/kontourai/flow-agents/compare/v3.0.0...v3.1.0) (2026-07-04)


### Features

* **docs:** probe docs-write contract — vocabulary + decision deltas ([#311](https://github.com/kontourai/flow-agents/issues/311)) ([#371](https://github.com/kontourai/flow-agents/issues/371)) ([867c3b5](https://github.com/kontourai/flow-agents/commit/867c3b5b645c896e5df6886177171b05e73e8fa9))
* **knowledge:** neo4j knowledge-store provider — Cypher-backed [#317](https://github.com/kontourai/flow-agents/issues/317) interface (opt-in default) ([#373](https://github.com/kontourai/flow-agents/issues/373)) ([2ef2523](https://github.com/kontourai/flow-agents/commit/2ef2523cc65a5e56dec8dcbf84edc3718cfe190c))
* **knowledge:** promote sub-flow — ingest→distill→link→health (flow within a flow) ([#313](https://github.com/kontourai/flow-agents/issues/313)) ([#372](https://github.com/kontourai/flow-agents/issues/372)) ([b345d89](https://github.com/kontourai/flow-agents/commit/b345d89873c99f65f00d0fe8ede6a8702b1a2b43))
* **knowledge:** stable record identity — short-id prefix + slug aliases ([#339](https://github.com/kontourai/flow-agents/issues/339)) ([ff54bc7](https://github.com/kontourai/flow-agents/commit/ff54bc74f893321f13276cd147d500f91e1fc133))


### Documentation

* **adr:** ADR freeze cutover + liveness coordination experiment ([#332](https://github.com/kontourai/flow-agents/issues/332)) ([#368](https://github.com/kontourai/flow-agents/issues/368)) ([2c845b8](https://github.com/kontourai/flow-agents/commit/2c845b81675db02622fee8fa1efa6aa197ce96c0))

## [3.0.0](https://github.com/kontourai/flow-agents/compare/v2.4.0...v3.0.0) (2026-07-04)


### ⚠ BREAKING CHANGES

* **trust:** require origin/check_kind stamps — remove pre-supersession read fallback ([#355](https://github.com/kontourai/flow-agents/issues/355))

### Features

* **routing:** model-routing policy as datum roles — orchestrator resolves at delegation ([#365](https://github.com/kontourai/flow-agents/issues/365)) ([7acf663](https://github.com/kontourai/flow-agents/commit/7acf6635125623505097eb0f7d2b0da7026c1b00))
* **trust-anchor:** fail-closed delivery reconciliation with governed exemptions (ADR 0022 §1) ([#358](https://github.com/kontourai/flow-agents/issues/358)) ([0631050](https://github.com/kontourai/flow-agents/commit/0631050c7d88f3dd38d7c90ee1af5adf63410334))


### Fixes

* **trust:** critique supersession + lossless check/critique round-trip (closes [#267](https://github.com/kontourai/flow-agents/issues/267), [#268](https://github.com/kontourai/flow-agents/issues/268), [#282](https://github.com/kontourai/flow-agents/issues/282)) ([#344](https://github.com/kontourai/flow-agents/issues/344)) ([c2c3fd5](https://github.com/kontourai/flow-agents/commit/c2c3fd5d322d2537847d67a6fefc6daae6893070))
* **trust:** require origin/check_kind stamps — remove pre-supersession read fallback ([#355](https://github.com/kontourai/flow-agents/issues/355)) ([ab27f71](https://github.com/kontourai/flow-agents/commit/ab27f71ac1ee652b7125ce01336895d34162472b))


### Documentation

* **contracts:** standing owner directives — durable home for ratified policy ([#351](https://github.com/kontourai/flow-agents/issues/351)) ([e335d54](https://github.com/kontourai/flow-agents/commit/e335d540378ba7eaae5bb7162427d8db16f58e4b))

## [2.4.0](https://github.com/kontourai/flow-agents/compare/v2.3.0...v2.4.0) (2026-07-03)


### Features

* **decisions:** topic-keyed living decision registry contract (Closes [#310](https://github.com/kontourai/flow-agents/issues/310)) ([#316](https://github.com/kontourai/flow-agents/issues/316)) ([0bd4e0b](https://github.com/kontourai/flow-agents/commit/0bd4e0ba593480c1e11988d2f9257082a3f06b4a))
* **gates:** regression-lock the FlowDefinition-driven stop gate + gate-named block messages (ADR 0016 Abstraction A closeout) ([#265](https://github.com/kontourai/flow-agents/issues/265)) ([0fd0c0e](https://github.com/kontourai/flow-agents/commit/0fd0c0e56c3a8e007f116c77937f9fc61d9a6be7))
* **kits:** cross-kit dependencies, skill-collision fixes, sidecar governance ([#264](https://github.com/kontourai/flow-agents/issues/264)) ([b2a4cc8](https://github.com/kontourai/flow-agents/commit/b2a4cc8abc1d7a822274fae90ee5e5e9e6dc7de5))
* **kits:** veritas-governance kit — readiness→trust-bundle adapter with settled gate semantics ([#269](https://github.com/kontourai/flow-agents/issues/269)) ([7a08396](https://github.com/kontourai/flow-agents/commit/7a083966db47672ea552f13264ea3111e08fa06b))
* **liveness:** default-on lifecycle + tool-activity heartbeats ([#288](https://github.com/kontourai/flow-agents/issues/288)) ([#306](https://github.com/kontourai/flow-agents/issues/306)) ([3134614](https://github.com/kontourai/flow-agents/commit/31346147311e829352b2219ce1a91b6babc5ec27))
* **liveness:** runtime-agnostic actor identity; retire the "local" default ([#287](https://github.com/kontourai/flow-agents/issues/287)) ([#296](https://github.com/kontourai/flow-agents/issues/296)) ([204a4c6](https://github.com/kontourai/flow-agents/commit/204a4c68643587727b7d0c22390de4375a24ea6e))
* promote-then-archive gate — durable-residue extraction is the archival act (Closes [#312](https://github.com/kontourai/flow-agents/issues/312)) ([#319](https://github.com/kontourai/flow-agents/issues/319)) ([490542c](https://github.com/kontourai/flow-agents/commit/490542caf461ab4e5bff1542f3e56f4fdc9fd234))
* **pull-work:** liveness selection preflight — exclude held, claim on selection ([#329](https://github.com/kontourai/flow-agents/issues/329)) ([8c76568](https://github.com/kontourai/flow-agents/commit/8c76568407d37b145b5d3ea420c8b9746d2b5ac5))
* **trust-anchor:** manifest-based reconcile, claim classification, loud attestations (WS8) ([55b66db](https://github.com/kontourai/flow-agents/commit/55b66dbf8c3c30f828439f1983669722981bcbae))
* **trust-bundle:** migrate to @kontourai/surface 2.0.0 (Claim.facet rename) ([#277](https://github.com/kontourai/flow-agents/issues/277)) ([573b45e](https://github.com/kontourai/flow-agents/commit/573b45ec28453392bc11286ef7378b6627c790e0))
* **veritas-governance:** migrate adapter to facet + schemaVersion 5 ([#285](https://github.com/kontourai/flow-agents/issues/285)) ([1948639](https://github.com/kontourai/flow-agents/commit/19486395e1c57231b9b8c9ec805d2fe2f720426e)), closes [#281](https://github.com/kontourai/flow-agents/issues/281)
* **workflow:** branch as first-class routing state with agent/&lt;actor&gt;/&lt;slug&gt; convention ([#308](https://github.com/kontourai/flow-agents/issues/308)) ([739575c](https://github.com/kontourai/flow-agents/commit/739575c8f5f43a1f056982201cddaae699fe6409))


### Fixes

* **bundles:** resolve Codex hook script with HOME fallback; fail open with diagnostic ([e9c5993](https://github.com/kontourai/flow-agents/commit/e9c5993d84483c114641090026afaedc70afdcdb))
* **evals:** heal integration lanes after runtime-path split ([20cdb36](https://github.com/kontourai/flow-agents/commit/20cdb36ac4b5704599faa524a5189d288b6d8a40))
* **evals:** register WS8 fixtures with the retirement audit ([95f6baf](https://github.com/kontourai/flow-agents/commit/95f6bafe37a4eb492d6ccb70892f0038e35a3850))
* **flow-agents:** resolve claude-code --global hook paths absolutely ([9148033](https://github.com/kontourai/flow-agents/commit/9148033f7c1e02512550f342d1bf3ac5e80fdf9d))
* **sidecar:** preserve branch and created_at across init-plan; add field-preservation invariant sweep ([#315](https://github.com/kontourai/flow-agents/issues/315)) ([cae9c38](https://github.com/kontourai/flow-agents/commit/cae9c38d2d311e6205f665cc4943808748effaec))


### Documentation

* **adr:** ADR 0021 — assignment leases and stale-claim takeover ([#286](https://github.com/kontourai/flow-agents/issues/286)) ([df345dd](https://github.com/kontourai/flow-agents/commit/df345dd8a1dc067fff2d03334041b373057eb79c))
* **adr:** ADR 0022 — fail-closed delivery reconciliation with governed exemptions ([#299](https://github.com/kontourai/flow-agents/issues/299)) ([046005a](https://github.com/kontourai/flow-agents/commit/046005af025663de005684c92fd825eab73fb8b1))
* **learnings:** 2026-07 improvement-program learning review ([#284](https://github.com/kontourai/flow-agents/issues/284)) ([514b6ad](https://github.com/kontourai/flow-agents/commit/514b6ad346d0e42939b4c03bdee976fe0c166bf3))


### Refactoring

* **flow-agents:** centralize Codex home default helper ([dc9995c](https://github.com/kontourai/flow-agents/commit/dc9995cdc43a456ab6248307ef6d5ace59559313))

## [2.3.0](https://github.com/kontourai/flow-agents/compare/v2.2.0...v2.3.0) (2026-07-01)


### Features

* **strands-ts:** consume @kontourai/console-telemetry for pricing/cost ([eb878b0](https://github.com/kontourai/flow-agents/commit/eb878b024a166b68d5cef00cd659311de9c7b49b))

## [2.2.0](https://github.com/kontourai/flow-agents/compare/v2.1.1...v2.2.0) (2026-06-30)


### Features

* **strands-ts:** consume @kontourai/console-telemetry for pricing/cost ([#243](https://github.com/kontourai/flow-agents/issues/243)) ([eba7ff3](https://github.com/kontourai/flow-agents/commit/eba7ff39433f602e7e17b17164a84fa187aa3dc8))


### Fixes

* **flow-agents:** expose kontourai artifact roots ([#258](https://github.com/kontourai/flow-agents/issues/258)) ([82db131](https://github.com/kontourai/flow-agents/commit/82db1319e9115820c606c71c40087c05b1278fce))


### Documentation

* **flow-agents:** ADR 0018 — freeze local shell-parsing heuristics (ops[#21](https://github.com/kontourai/flow-agents/issues/21)) ([#255](https://github.com/kontourai/flow-agents/issues/255)) ([777fc50](https://github.com/kontourai/flow-agents/commit/777fc5029409f85bb3097da7f3141e3b4783a789))


### Refactoring

* **flow-agents:** extract a pure seam from workflow-sidecar + add TS unit layer (ops[#22](https://github.com/kontourai/flow-agents/issues/22)) ([#257](https://github.com/kontourai/flow-agents/issues/257)) ([7af3f44](https://github.com/kontourai/flow-agents/commit/7af3f44fb1d4c05e155da9e4f6090f1a99b534ef))

## [2.1.1](https://github.com/kontourai/flow-agents/compare/v2.1.0...v2.1.1) (2026-06-29)


### Refactoring

* **flow-agents:** one shared module for command-log chain helpers (ops[#20](https://github.com/kontourai/flow-agents/issues/20)) ([#249](https://github.com/kontourai/flow-agents/issues/249)) ([67af85f](https://github.com/kontourai/flow-agents/commit/67af85f5010dace3f33b36b86245e0c7aad95f77))

## [2.1.0](https://github.com/kontourai/flow-agents/compare/v2.0.1...v2.1.0) (2026-06-29)


### Features

* **telemetry:** derive live pricing source from the console ([#242](https://github.com/kontourai/flow-agents/issues/242)) ([ddce44e](https://github.com/kontourai/flow-agents/commit/ddce44e813e9a3515953324f4878bf51c33252ba))
* **telemetry:** real token+cost capture with single-source versioned pricing ([#241](https://github.com/kontourai/flow-agents/issues/241)) ([b0bd4c3](https://github.com/kontourai/flow-agents/commit/b0bd4c347897ec77f60d84cae702e7f42b2871d7))


### Fixes

* **evidence-capture:** serialize command-log appends to prevent chain forks ([#232](https://github.com/kontourai/flow-agents/issues/232)) ([bb167e9](https://github.com/kontourai/flow-agents/commit/bb167e93e7f6cc19baa88da613e96fe88a681c10))
* **flow-agents:** stop corrupting sidecar JSONL event lines ([#244](https://github.com/kontourai/flow-agents/issues/244)) ([fb65d10](https://github.com/kontourai/flow-agents/commit/fb65d1017e5cb659ce2b48da7a548f0c1f360426))
* **trust-verify action:** correct cross-repo script path (../../ → ../../../) ([#240](https://github.com/kontourai/flow-agents/issues/240)) ([a75a6d2](https://github.com/kontourai/flow-agents/commit/a75a6d28baf68b4be527a2e8cdff8f007af88bd5))


### Documentation

* **design:** preserve WorkflowRun observability + FlowRun event-sourcing design notes ([#239](https://github.com/kontourai/flow-agents/issues/239)) ([c2dc116](https://github.com/kontourai/flow-agents/commit/c2dc11698cf63704f14087001c4494079195d197))
* **flow-agents:** advertise the real eval coverage, clearly scoped (ops[#23](https://github.com/kontourai/flow-agents/issues/23)) ([#248](https://github.com/kontourai/flow-agents/issues/248)) ([d208207](https://github.com/kontourai/flow-agents/commit/d20820749408d5fa63f2bf1470252000712de5d8))

## [2.0.1](https://github.com/kontourai/flow-agents/compare/v2.0.0...v2.0.1) (2026-06-27)


### Fixes

* carry KIT IDENTITY through the trust chain — stop flattening non-builder kits to "builder" ([#235](https://github.com/kontourai/flow-agents/issues/235)) ([02d2782](https://github.com/kontourai/flow-agents/commit/02d2782ca8d9158a018d0fc6c35adc6a34c827d5))
* **gate:** classify concurrent-fork vs tamper; never hard-block a benign race ([#233](https://github.com/kontourai/flow-agents/issues/233)) ([e24743b](https://github.com/kontourai/flow-agents/commit/e24743b7dbff05df64e198e420e47841ce534df3))

## [2.0.0](https://github.com/kontourai/flow-agents/compare/v1.4.0...v2.0.0) (2026-06-27)


### ⚠ BREAKING CHANGES

* **liveness:** rename coord→liveness + lifecycle-driven liveness claims (ADR 0012) ([#154](https://github.com/kontourai/flow-agents/issues/154))

### Features

* activate FlowDefinition-driven sessions + fix carry-forward history loss (ADR 0016 Abstraction A, Step 0+1) ([#208](https://github.com/kontourai/flow-agents/issues/208)) ([7e0120f](https://github.com/kontourai/flow-agents/commit/7e0120fd60779186dbe87db5cad313d479ff4ef8))
* **builder:** add continue-work skill for fresh-context slice handoff ([#190](https://github.com/kontourai/flow-agents/issues/190)) ([8353fef](https://github.com/kontourai/flow-agents/commit/8353fef09967f813304c39f111b31861f4ca6fd0))
* **builder:** phase_map + advance-state active-step + record-gate-claim mechanism (ADR 0016 Abstraction A, P-d increment 1) ([#206](https://github.com/kontourai/flow-agents/issues/206)) ([9c67730](https://github.com/kontourai/flow-agents/commit/9c677309e6716485f1d2df4e15071379b8dc28fe))
* **builder:** wire 6 step producers via record-gate-claim + flip required:true + fix --expectation targeting (ADR 0016 Abstraction A, P-d increment 2) ([#207](https://github.com/kontourai/flow-agents/issues/207)) ([4cf6e52](https://github.com/kontourai/flow-agents/commit/4cf6e524f97b7ea4dd739e9de83aedcfb07ba055))
* **ci:** CI mints a signed attestation over its own verification results (CI anchor Phase 2) ([#224](https://github.com/kontourai/flow-agents/issues/224)) ([017505b](https://github.com/kontourai/flow-agents/commit/017505b9f7d2200eacf2dd681182dc968d61dc23))
* **ci:** publish session bundle to delivery/ at delivery — feed the trust-reconcile anchor (Phase 1b) ([#223](https://github.com/kontourai/flow-agents/issues/223)) ([d9476d8](https://github.com/kontourai/flow-agents/commit/d9476d847310d348c20f53ba824756a30a1b23b0))
* **ci:** trust-reconcile job — the external anti-gaming anchor (CI anchor Phase 1) ([#222](https://github.com/kontourai/flow-agents/issues/222)) ([1678866](https://github.com/kontourai/flow-agents/commit/1678866f6c967117bb09e15b9546c89462b392f3))
* **context:** add gate-awareness self-critique doc + AGENTS.md reference ([#118](https://github.com/kontourai/flow-agents/issues/118)) ([#123](https://github.com/kontourai/flow-agents/issues/123)) ([45e3841](https://github.com/kontourai/flow-agents/commit/45e38410a8c9276713675531d25d4870f99b1be8))
* **coord:** agent coordination as liveness claims — claim/heartbeat/release/status (ADR 0012) ([#150](https://github.com/kontourai/flow-agents/issues/150)) ([ed248ed](https://github.com/kontourai/flow-agents/commit/ed248edbe39a39ac7403ffdce316d4c19fda25b0))
* **core:** FlowDefinition-driven claim production — shared flow-resolver + producer dual-emit (ADR 0016 Abstraction A, P-a/P-b) ([#204](https://github.com/kontourai/flow-agents/issues/204)) ([5368017](https://github.com/kontourai/flow-agents/commit/536801781d8bb2d2e00754539d16efa050cb2d42))
* **core:** gate enforces on the active FlowDefinition's expects[] (ADR 0016 Abstraction A, P-c) ([#205](https://github.com/kontourai/flow-agents/issues/205)) ([dd0dab2](https://github.com/kontourai/flow-agents/commit/dd0dab20d513e26ce57354137e9931bdd15c0633))
* **gate-review:** deterministic gate-calibration via canonical Surface InquiryRecord ([#119](https://github.com/kontourai/flow-agents/issues/119)) ([#132](https://github.com/kontourai/flow-agents/issues/132)) ([d5ec073](https://github.com/kontourai/flow-agents/commit/d5ec073bcd3c0ba3075993453db0f932cf381686))
* **goal-fit:** re-derive trust.bundle claim status at the gate (ADR 0010 Phase 2 hardening) ([#136](https://github.com/kontourai/flow-agents/issues/136)) ([face2cb](https://github.com/kontourai/flow-agents/commit/face2cb5f2bcacd65c70dc22da72e0585874cde3))
* **hooks:** capture-first evidence determinism for command checks ([#115](https://github.com/kontourai/flow-agents/issues/115)) ([a5bd12f](https://github.com/kontourai/flow-agents/commit/a5bd12f0ad7629b79043356dae3e34acd22aabd0))
* **hooks:** goal-fit teeth + active-goal reground (block false-completion, survive compaction) ([#113](https://github.com/kontourai/flow-agents/issues/113)) ([40ba70b](https://github.com/kontourai/flow-agents/commit/40ba70bdf351d885965ae2e70861e07745547237))
* **install:** extend merge-aware install to codex — preserve user hooks.json ([#117](https://github.com/kontourai/flow-agents/issues/117)) ([#158](https://github.com/kontourai/flow-agents/issues/158)) ([212f097](https://github.com/kontourai/flow-agents/commit/212f097de0ec266d5d6ea6e016a3123c3f39d465))
* **install:** merge opencode.json + uniform version stamp across all runtimes ([#117](https://github.com/kontourai/flow-agents/issues/117)) ([#159](https://github.com/kontourai/flow-agents/issues/159)) ([bab6f68](https://github.com/kontourai/flow-agents/commit/bab6f684c0c5bdc36588d4b25f6e595333e76939))
* **install:** merge-aware global installs — opencode/codex --global + codex-home (closes [#117](https://github.com/kontourai/flow-agents/issues/117) deferred gaps) ([#188](https://github.com/kontourai/flow-agents/issues/188)) ([a133b39](https://github.com/kontourai/flow-agents/commit/a133b39a77bd108ccc39b879086e74d4f93ed435))
* **install:** merge-aware install for claude-code — preserve user config + version stamp + --global ([#117](https://github.com/kontourai/flow-agents/issues/117)) ([#157](https://github.com/kontourai/flow-agents/issues/157)) ([01d03c0](https://github.com/kontourai/flow-agents/commit/01d03c006d41fd9b2579675637bc3a07f64d0624))
* **knowledge:** add glossary-sync and detect-contradictions hygiene flows ([#106](https://github.com/kontourai/flow-agents/issues/106)) ([#197](https://github.com/kontourai/flow-agents/issues/197)) ([6c34c38](https://github.com/kontourai/flow-agents/commit/6c34c38560120ea61c47a6c52946c6273e28f69a))
* **knowledge:** add hygiene-review orchestrator over the four hygiene flows ([#106](https://github.com/kontourai/flow-agents/issues/106)) ([#199](https://github.com/kontourai/flow-agents/issues/199)) ([34ecf37](https://github.com/kontourai/flow-agents/commit/34ecf37bf6cf125ac368800c1ba5aada53d37c82))
* **knowledge:** add knowledge.audit-freshness hygiene flow ([#106](https://github.com/kontourai/flow-agents/issues/106)) ([#189](https://github.com/kontourai/flow-agents/issues/189)) ([33f7ebb](https://github.com/kontourai/flow-agents/commit/33f7ebb2ebacce007ab690ea0f802b5476dc8385))
* **knowledge:** add knowledge.canonicalize-category hygiene flow ([#106](https://github.com/kontourai/flow-agents/issues/106)) ([#193](https://github.com/kontourai/flow-agents/issues/193)) ([e5a02ce](https://github.com/kontourai/flow-agents/commit/e5a02ceb703f51387623260df95c7a262709b633))
* **knowledge:** add store reindex() — rebuild graph index from records (recovery, [#106](https://github.com/kontourai/flow-agents/issues/106)) ([#185](https://github.com/kontourai/flow-agents/issues/185)) ([377bf59](https://github.com/kontourai/flow-agents/commit/377bf59802d29e6fce0dae0bfc793cd5f4e493dc))
* per-run trust checkpoint — terminal seal + freshness drift on resume (consume surface checkpointFromReport/diffFreshness) ([#210](https://github.com/kontourai/flow-agents/issues/210)) ([04a6e63](https://github.com/kontourai/flow-agents/commit/04a6e6344ff1e921b8f0c4bd8b93ddd753e61adb))
* productize the trust anchor — `flow-agents verify` CLI + reusable composite Action + adoption docs (CI anchor Phase 3) ([#231](https://github.com/kontourai/flow-agents/issues/231)) ([305515f](https://github.com/kontourai/flow-agents/commit/305515f2594fafc3815b847024c1d91a9a7db1fe))
* remove legacy packs layer entirely (no backwards compatibility) ([#121](https://github.com/kontourai/flow-agents/issues/121)) ([a7325b5](https://github.com/kontourai/flow-agents/commit/a7325b5447de1e91524a1118ab44a497ab462be8))
* **resume:** liveness-aware + claim-aware RESUME block on SessionStart ([#153](https://github.com/kontourai/flow-agents/issues/153), first slice) ([#184](https://github.com/kontourai/flow-agents/issues/184)) ([71155bd](https://github.com/kontourai/flow-agents/commit/71155bd01f6b5cb8c20cd7b9e75567f2e9dae9aa))
* retire the -legacy dual-emit shadow — FlowDefinition-driven sessions are declared-only (ADR 0016, P-d) ([#209](https://github.com/kontourai/flow-agents/issues/209)) ([d9073de](https://github.com/kontourai/flow-agents/commit/d9073decd73de3cc436669c9d8fab8070e515373))
* sign the terminal checkpoint at release — in-toto/DSSE attestation (consume surface Sigstore, the real external integrity anchor) ([#211](https://github.com/kontourai/flow-agents/issues/211)) ([df8df2f](https://github.com/kontourai/flow-agents/commit/df8df2f1a6bfdc8494fb064414975c48600b5627))
* tamper-evident command-log.jsonl via hash-chain — the gate detects an altered/removed capture entry (B2) ([#212](https://github.com/kontourai/flow-agents/issues/212)) ([ff9b058](https://github.com/kontourai/flow-agents/commit/ff9b05867370775f918377d1a9a647cc867fd18c))
* **trust-bundle:** maximal enrichment + gate enforces on the canonical bundle (ADR 0010 Ph1+2 core) ([#133](https://github.com/kontourai/flow-agents/issues/133)) ([fa4115e](https://github.com/kontourai/flow-agents/commit/fa4115eb84fde743db60e066de745a0811360ac4))
* **trust-mcp:** opt-in trust-mcp command to wire Surface's MCP for trust surfacing ([#137](https://github.com/kontourai/flow-agents/issues/137)) ([#141](https://github.com/kontourai/flow-agents/issues/141)) ([b7beb43](https://github.com/kontourai/flow-agents/commit/b7beb4335afcc2bdd6fd0abd278dd4023c08a63b))
* **trust-panel:** render-trust-panel — project the bundle to a standalone Surface Trust Panel (ADR 0010 Phase 3 local) ([#135](https://github.com/kontourai/flow-agents/issues/135)) ([e1b3c35](https://github.com/kontourai/flow-agents/commit/e1b3c357156c2b5b631e5ad68cda378b73a5aab5))
* **trust-panel:** render-trust-panel also emits trust-report.json (universal Surface input) ([#140](https://github.com/kontourai/flow-agents/issues/140)) ([c430634](https://github.com/kontourai/flow-agents/commit/c4306341a42948db3604b0b4b14d6f930301a4e5))
* **validate:** guard against duplicate ADR numbers in validate-source-tree ([#191](https://github.com/kontourai/flow-agents/issues/191)) ([d0592eb](https://github.com/kontourai/flow-agents/commit/d0592eb09f1206c7c77a3836dfba18935a19f2f3))
* **workflow-sidecar:** claim-lookup tool — status + failing evidence + how-to-verify + why ([#162](https://github.com/kontourai/flow-agents/issues/162)) ([#173](https://github.com/kontourai/flow-agents/issues/173)) ([4b72cba](https://github.com/kontourai/flow-agents/commit/4b72cbace5cb3007ddad593e947e03cb173e4df3))
* **workflow-sidecar:** deterministic session slug from work-item ref ([#161](https://github.com/kontourai/flow-agents/issues/161)) ([#165](https://github.com/kontourai/flow-agents/issues/165)) ([e69fa26](https://github.com/kontourai/flow-agents/commit/e69fa26fcb8b63f1f216d8f31ac43622decd808d))
* **workflow-sidecar:** dual-write workflow trust state as local Hachure trust.bundle (ADR 0010 Phase 1) ([#126](https://github.com/kontourai/flow-agents/issues/126)) ([#130](https://github.com/kontourai/flow-agents/issues/130)) ([a9b8fd6](https://github.com/kontourai/flow-agents/commit/a9b8fd6061d05a3d73321108c942769c005bff11))


### Fixes

* **goal-fit:** re-derive-tamper block fires independent of backstop + protect it in CI ([#196](https://github.com/kontourai/flow-agents/issues/196)) ([9d13212](https://github.com/kontourai/flow-agents/commit/9d13212bb9b72c979d7c1de0aa64299aeb483d53))
* **knowledge:** auto-close spent proposal artifact on retire apply ([#106](https://github.com/kontourai/flow-agents/issues/106)) ([#186](https://github.com/kontourai/flow-agents/issues/186)) ([9835c06](https://github.com/kontourai/flow-agents/commit/9835c066a61ad99c6addda07a5387aa5e606165b))
* **security:** captureCrossReference now sees declared-type claims — declared-type false-completions BLOCK (adversarial review Finding 1, CRITICAL) ([#214](https://github.com/kontourai/flow-agents/issues/214)) ([0d1d4de](https://github.com/kontourai/flow-agents/commit/0d1d4def66164bb2f584074796338d594c951cff))
* **security:** captured-FAIL reconciliation — close the namespace-agnostic false-completion bypass (Round 2 red-team CRITICAL) + fix [#216](https://github.com/kontourai/flow-agents/issues/216) over-block ([#218](https://github.com/kontourai/flow-agents/issues/218)) ([e9bf229](https://github.com/kontourai/flow-agents/commit/e9bf229ee3380282cb60db3645e7969f6129929c))
* **security:** checkpoint signature now signs the on-disk bytes — attestation moved to a companion file (adversarial review HIGH/A02) ([#213](https://github.com/kontourai/flow-agents/issues/213)) ([b27fd14](https://github.com/kontourai/flow-agents/commit/b27fd1478549f867409f7053e2a9044ba337fb85))
* **security:** CI anchor verifies the REAL deliverable, not just compilation (Round 5 soundness) ([#226](https://github.com/kontourai/flow-agents/issues/226)) ([1117624](https://github.com/kontourai/flow-agents/commit/111762482272658e56bbbf8d4f51d5af6ea4e647))
* **security:** close the full gate-bypass chain — path-traversal sanitization + empty-gateExpects union (adversarial review HIGH/A01/A04) ([#215](https://github.com/kontourai/flow-agents/issues/215)) ([2554656](https://github.com/kontourai/flow-agents/commit/2554656551c01e9b63b2acc98b83c862a1b29d59))
* **security:** lock down gate bypass surfaces — config protection, MAX_BLOCKS hard-block guard, fail-closed (adversarial review Findings 2 + fail-opens) ([#216](https://github.com/kontourai/flow-agents/issues/216)) ([370ebc5](https://github.com/kontourai/flow-agents/commit/370ebc5edfdc80a53a2c4154b0767e9be4221b6f))
* **security:** protect state.json + trust.bundle from agent Write/Edit; best-effort flag node -e/sed -i/python -c profile writes (Round 4 audit) ([#220](https://github.com/kontourai/flow-agents/issues/220)) ([ef68054](https://github.com/kontourai/flow-agents/commit/ef680545d5c351dca3a4abf4d21c95eb7e44576e))
* **security:** resolveFirstStep traversal + tee multi-file evasion (Round 2 audit MEDIUM/LOW) ([#217](https://github.com/kontourai/flow-agents/issues/217)) ([ac1f3cd](https://github.com/kontourai/flow-agents/commit/ac1f3cdc99b90e16a593dc5380eda5cc469af98a))
* **security:** robust laundering detection (any ||) + delivery/ bundle protection (Round 5) ([#227](https://github.com/kontourai/flow-agents/issues/227)) ([d09bebe](https://github.com/kontourai/flow-agents/commit/d09bebe14e30779b193e225f4ecc2ff98e0ca00c))
* **security:** run the anti-gaming suite in a REQUIRED CI lane + screen the canonical verify + own the verify config (Round 7) ([#228](https://github.com/kontourai/flow-agents/issues/228)) ([0d68ab1](https://github.com/kontourai/flow-agents/commit/0d68ab13caffd8f703f552e56a03a6c5499d1d51))
* **security:** status-independent false-completion check + drop Case B over-block + flag exit-code laundering (Round 4) ([#219](https://github.com/kontourai/flow-agents/issues/219)) ([ef53339](https://github.com/kontourai/flow-agents/commit/ef53339ef6ad5e92275f8753ee59d73628020142))
* untrack accidental node_modules symlink + harden .gitignore ([#181](https://github.com/kontourai/flow-agents/issues/181) fallout) ([#182](https://github.com/kontourai/flow-agents/issues/182)) ([9042ff6](https://github.com/kontourai/flow-agents/commit/9042ff6a029c75a4555d4b94daa2291b3284930a))
* **writers:** bundle-writers fail loudly instead of silently losing data ([#156](https://github.com/kontourai/flow-agents/issues/156)) ([#160](https://github.com/kontourai/flow-agents/issues/160)) ([6e9e3a6](https://github.com/kontourai/flow-agents/commit/6e9e3a69119f40c571360025426687d0ff69f3a4))


### Documentation

* **adr:** ADR 0011 — MCP posture (enforcement stays hooks; Surface owns MCP projection; no auto-injected config) ([#138](https://github.com/kontourai/flow-agents/issues/138)) ([e65f2ae](https://github.com/kontourai/flow-agents/commit/e65f2ae593617ef8e31a154a6847135f91d4ff83))
* **adr:** ADR 0012 — agent coordination as Hachure liveness claims ([#145](https://github.com/kontourai/flow-agents/issues/145)) ([c57138f](https://github.com/kontourai/flow-agents/commit/c57138f0ff075578a381c398d549baca814edb10))
* **adr:** ADR 0013 — context lifecycle (workflow-boundary compaction, freshness-gated reuse, learning split) ([#163](https://github.com/kontourai/flow-agents/issues/163)) ([0589687](https://github.com/kontourai/flow-agents/commit/0589687d46e42c951a64e5e1b9a727e7691fe384))
* **adr:** ADR 0015 reassessment — Tiers 1 & 2 closed-by-evaluation (audit overstated drift) ([#198](https://github.com/kontourai/flow-agents/issues/198)) ([dde8c21](https://github.com/kontourai/flow-agents/commit/dde8c212e0c5f974e6bb9097c72806288f4be53f))
* **adr:** ADR 0016 — the three-hard-boundary model (FlowDefinition-driven kit-agnostic core) + sync 0014/0009/0004/0005 ([#203](https://github.com/kontourai/flow-agents/issues/203)) ([6ded109](https://github.com/kontourai/flow-agents/commit/6ded109802679a11d0edf88207a429f92eef8321))
* **adr:** ADR 0017 — the anti-gaming trust security model (layered defense + external CI anchor) ([#229](https://github.com/kontourai/flow-agents/issues/229)) ([bf794ce](https://github.com/kontourai/flow-agents/commit/bf794ce06a7b5e71579479813affa15e0859ef41))
* **adr:** correct ADR 0015 — Tier 2 reopened as Resource Contract migration (was wrongly closed) ([#202](https://github.com/kontourai/flow-agents/issues/202)) ([ec3a67b](https://github.com/kontourai/flow-agents/commit/ec3a67b8ca82fa7fedc579b5b404b58dcd5a708e))
* **adr:** renumber Flow/Flow-Agents boundary ADR 0014 → 0015 (resolve duplicate) ([#181](https://github.com/kontourai/flow-agents/issues/181)) ([1b581b7](https://github.com/kontourai/flow-agents/commit/1b581b722a060961e4deae6b775da68f7c350616))
* **agents:** capture merge-burst + fresh-handoff learnings in operating agreements ([#192](https://github.com/kontourai/flow-agents/issues/192)) ([31d5473](https://github.com/kontourai/flow-agents/commit/31d547330771fc77a4930fa8727ac078151d8ff4))
* **agents:** scope worktree cleanup to your own paths (operating agreement) ([#201](https://github.com/kontourai/flow-agents/issues/201)) ([ae6cf41](https://github.com/kontourai/flow-agents/commit/ae6cf413a0b79658855d991a56fc4916400277db))
* **contracts:** fail-loud + flake-is-a-real-bug in core review/verification contracts ([#170](https://github.com/kontourai/flow-agents/issues/170)) ([c25b48c](https://github.com/kontourai/flow-agents/commit/c25b48c7e58cda0c2803a44646996615c4de6cf7))
* seed kit-development operating agreements in AGENTS.md (ADR 0013) ([#164](https://github.com/kontourai/flow-agents/issues/164)) ([0b6e765](https://github.com/kontourai/flow-agents/commit/0b6e765a2348ddc709f6829cc163c1379498193a))
* Verifiable Trust — user-facing value/use-case doc for the anti-gaming trust model ([#230](https://github.com/kontourai/flow-agents/issues/230)) ([8710e29](https://github.com/kontourai/flow-agents/commit/8710e29ec9a0ea15f6e22e82e5d695a19aadc3b6))


### Refactoring

* **goal-fit:** drop bespoke markdown/DELIVERY_TYPES gate parsing — verdict is bundle-driven (ADR 0010 2c) ([#139](https://github.com/kontourai/flow-agents/issues/139)) ([342d7aa](https://github.com/kontourai/flow-agents/commit/342d7aaecea93c156a11a49467cb7167af888654))
* **goal-fit:** gate consumers read the trust.bundle, not bespoke sidecars (ADR 0010 Phase 4b) ([#146](https://github.com/kontourai/flow-agents/issues/146)) ([7ae2e2c](https://github.com/kontourai/flow-agents/commit/7ae2e2ce04205c874810596c5db132dfdf0ad85a))
* **liveness:** rename coord→liveness + lifecycle-driven liveness claims (ADR 0012) ([#154](https://github.com/kontourai/flow-agents/issues/154)) ([4576e0e](https://github.com/kontourai/flow-agents/commit/4576e0e8a03eaa49a3de9acf46a35c22b4cc36aa))
* **workflow-sidecar:** bundle is the primary artifact, sidecars projected (ADR 0010 Phase 4a) ([#144](https://github.com/kontourai/flow-agents/issues/144)) ([256ee9e](https://github.com/kontourai/flow-agents/commit/256ee9ef0879344c9c61724a8b58314b9a48129c))
* **workflow-sidecar:** consume surface's validateTrustBundle — retire bespoke validator ([#175](https://github.com/kontourai/flow-agents/issues/175), Tier 0) ([#180](https://github.com/kontourai/flow-agents/issues/180)) ([0cee634](https://github.com/kontourai/flow-agents/commit/0cee63421c7b327b608abef54b3a327d2187b2b3))
* **workflow-sidecar:** retire bespoke sidecars — bundle-only workspace (ADR 0010 Phase 4c) ([#152](https://github.com/kontourai/flow-agents/issues/152)) ([03432cb](https://github.com/kontourai/flow-agents/commit/03432cb536eeb90a49638391d506ecd6df7acfaa))

## [1.4.0](https://github.com/kontourai/flow-agents/compare/v1.3.0...v1.4.0) (2026-06-16)


### Features

* **#100:** require block reasons to reach the model ([#102](https://github.com/kontourai/flow-agents/issues/102)) ([5007c63](https://github.com/kontourai/flow-agents/commit/5007c63906aa78028477ffd2da31142ed4c3d0a8))
* **#99:** export the workflow sidecar writer/validator as a library ([#101](https://github.com/kontourai/flow-agents/issues/101)) ([5baa294](https://github.com/kontourai/flow-agents/commit/5baa294486b09e0e64a9fb5a029155c53775f477))

## [1.3.0](https://github.com/kontourai/flow-agents/compare/v1.2.0...v1.3.0) (2026-06-16)


### Features

* add kit TRUST axis to inspect output — orthogonal to K-levels (issue [#79](https://github.com/kontourai/flow-agents/issues/79)) ([2a353d1](https://github.com/kontourai/flow-agents/commit/2a353d17ffb1da8b0fc23f442f52aa0676a1fabe))
* add TRUST axis to kit inspect — orthogonal to K-level capability (issue [#79](https://github.com/kontourai/flow-agents/issues/79)) ([02ac699](https://github.com/kontourai/flow-agents/commit/02ac699227c4071c16c936c3e01e5fd013466baf))
* **knowledge:** rendered-body-as-storage in Obsidian adapter ([baef40f](https://github.com/kontourai/flow-agents/commit/baef40f46f4016ba8b6c8afd1c61b91cade1de12))
* **knowledge:** rendered-body-as-storage in Obsidian adapter ([0a31c32](https://github.com/kontourai/flow-agents/commit/0a31c3233ee8772b000cb42dbef0a3fdc38ccf1c))
* migrate gate evidence from surface.claim to Hachure trust.bundle ([#97](https://github.com/kontourai/flow-agents/issues/97)) ([8ed43c4](https://github.com/kontourai/flow-agents/commit/8ed43c46c2a6887d32cd850bc8b2d97e7829f825))


### Fixes

* **#74:** console-learning test cross-platform + un-quarantine; docs([#39](https://github.com/kontourai/flow-agents/issues/39)): live-validation rule ([89b2bdb](https://github.com/kontourai/flow-agents/commit/89b2bdb44f3fa5ea629135f7e93410eee92efb1c))
* **#74:** un-quarantine console-learning test — passes 12/12 on Linux CI ([#89](https://github.com/kontourai/flow-agents/issues/89)) ([371ecd2](https://github.com/kontourai/flow-agents/commit/371ecd22cbd8e80b6404cbdd2825d4a94fb6573c))
* **#75:** assert opencode plugin load via factory marker file ([#96](https://github.com/kontourai/flow-agents/issues/96)) ([6c09288](https://github.com/kontourai/flow-agents/commit/6c092883bc4b2fd5a893431991ab75921f8b080b))
* acceptance harnesses poll for all required telemetry events (canary flake [#75](https://github.com/kontourai/flow-agents/issues/75)) ([a27b4ff](https://github.com/kontourai/flow-agents/commit/a27b4ff48c88908419ef079c447d8a9930aa707a))
* acceptance harnesses skip (not fail) when no telemetry produced — no-provider CI ([d9cba18](https://github.com/kontourai/flow-agents/commit/d9cba180ebcec9005bcd0c7b29f2608530c8acc3))
* acceptance harnesses skip telemetry assertions when no provider (canary [#75](https://github.com/kontourai/flow-agents/issues/75)) ([dbd0e7b](https://github.com/kontourai/flow-agents/commit/dbd0e7b77444ed5df93fb47a59d2704460742367))
* acceptance harnesses wait for ALL required telemetry events, not just file existence ([d9c86c0](https://github.com/kontourai/flow-agents/commit/d9c86c0987d42ab1f6c5c411884bcf1912bd8fab))
* **ci:** pin @kontourai/flow to ~1.2.0 ([#95](https://github.com/kontourai/flow-agents/issues/95)) ([fd97803](https://github.com/kontourai/flow-agents/commit/fd97803c97ade926b1985c42b1693d8e9890f9f1))
* **knowledge:** collision-proof body delimiter in Obsidian adapter ([4e2560c](https://github.com/kontourai/flow-agents/commit/4e2560cec3b0b8c2660879d059ce29f0cc88184a))
* **stop-goal-fit:** invoke built validator directly; skip on env errors ([#92](https://github.com/kontourai/flow-agents/issues/92)) ([7b3d520](https://github.com/kontourai/flow-agents/commit/7b3d5208497f3cc8d4f8137d21f16408f9d2689e))

## [1.2.0](https://github.com/kontourai/flow-agents/compare/v1.1.0...v1.2.0) (2026-06-15)


### Features

* **#62:** move Builder Kit skills into kits/builder, add Knowledge Kit skill, remove orphans ([3822e07](https://github.com/kontourai/flow-agents/commit/3822e075e9cd488f46124179ebf9a8459825b9c6))
* **#62:** move Builder Kit skills into kits/builder, Knowledge Kit skill, remove orphans ([31f63ca](https://github.com/kontourai/flow-agents/commit/31f63ca18019d51438accd3b5f1e03cb5f2873f2))
* delegate container validation to @kontourai/flow; rename flow-kit → flow-agents kit ([d39e909](https://github.com/kontourai/flow-agents/commit/d39e9090dad220a8159d2148d5a1effb2460ac9f))
* delegate container validation to @kontourai/flow; rename flow-kit → flow-agents kit (ADR 0008) ([4343e84](https://github.com/kontourai/flow-agents/commit/4343e845a992858c9441258bedbbf3c7302a8532))


### Fixes

* **ci:** install repo deps before building bundles in runtime-compat canary ([#76](https://github.com/kontourai/flow-agents/issues/76)) ([f8947aa](https://github.com/kontourai/flow-agents/commit/f8947aab5723ba9325372ea4054458ce21875bee))
* lazy-load @kontourai/flow in validate.ts so list/status/activate work without it ([99beebb](https://github.com/kontourai/flow-agents/commit/99beebb58f02dba374b35ae5e3df229cb39ea8d0))


### Documentation

* add ADR 0007 flow/skill/kit/tool boundary + skill audit ([20b5c7b](https://github.com/kontourai/flow-agents/commit/20b5c7b272e7ad7985640e70b6be71733cec9995))
* add Builder Kit quick-start guide and update index/README Quick Start ([2e89bf0](https://github.com/kontourai/flow-agents/commit/2e89bf08968a6f45a26ceddcddf5a66bf77d3f44))
* ADR 0007 flow/skill/kit/tool boundary + skill audit ([a1dde52](https://github.com/kontourai/flow-agents/commit/a1dde52eb3b051a0eab5712395f0266c7428ae0f))
* Builder Kit quick-start guide (zero to gated build flow) ([83237f7](https://github.com/kontourai/flow-agents/commit/83237f77812917d49c86547db87986d6dbfdbfd9))
* fold orphan rulings into ADR 0007, add ADR 0008 kit-operation boundary ([d547edc](https://github.com/kontourai/flow-agents/commit/d547edc954ea9d9a12039003d41401802f994097))
* mark ADRs 0007 + 0008 Accepted (decisions reached in 2026-06-15 design conversation) ([3eb7636](https://github.com/kontourai/flow-agents/commit/3eb7636c1c4f866fd119195936ec856425573dda))

## [1.1.0](https://github.com/kontourai/flow-agents/compare/v1.0.1...v1.1.0) (2026-06-15)


### Features

* activate skills and docs in kit runtime adapters (fix [#58](https://github.com/kontourai/flow-agents/issues/58)) ([dc726fd](https://github.com/kontourai/flow-agents/commit/dc726fd1d56e79b5bda577985aa87befe3a1eb9d))
* activate skills and docs in kit runtime adapters (fix [#58](https://github.com/kontourai/flow-agents/issues/58)) ([dc774e0](https://github.com/kontourai/flow-agents/commit/dc774e001b54f7a09f6ab81a6aafcf2ad8552b6d))


### Fixes

* apply realpathSync entry-guard to 7 remaining CLI/tool files ([c1b3272](https://github.com/kontourai/flow-agents/commit/c1b3272c623055662a63c5d11c6dbef5aabe1cf0))
* apply realpathSync entry-guard to all 16 affected CLI/tool files (closes [#71](https://github.com/kontourai/flow-agents/issues/71)) ([8a676b0](https://github.com/kontourai/flow-agents/commit/8a676b0c9c91464d64755719ff778a13e298beb9))
* apply realpathSync entry-guard to remaining 10 CLI/tool files ([159bb78](https://github.com/kontourai/flow-agents/commit/159bb785b6b28f99b0a3a5c95e0d4428512f4314))
* use hosted console io preset ([5b4bb7b](https://github.com/kontourai/flow-agents/commit/5b4bb7bc86d154bcf4d529a62e398a2196b702cc))

## [1.0.1](https://github.com/kontourai/flow-agents/compare/v1.0.0...v1.0.1) (2026-06-12)


### Fixes

* resolve three kit-distribution blockers ([#55](https://github.com/kontourai/flow-agents/issues/55) [#56](https://github.com/kontourai/flow-agents/issues/56) [#57](https://github.com/kontourai/flow-agents/issues/57)) ([3350cb1](https://github.com/kontourai/flow-agents/commit/3350cb15f44bff92d8d9c57f447761d0e1a1b20c))
* resolve three kit-distribution blockers ([#55](https://github.com/kontourai/flow-agents/issues/55), [#56](https://github.com/kontourai/flow-agents/issues/56), [#57](https://github.com/kontourai/flow-agents/issues/57)) ([13bf732](https://github.com/kontourai/flow-agents/commit/13bf732ff365efa84423e9ea46042e501d202db8))

## [1.0.0](https://github.com/kontourai/flow-agents/compare/v0.4.0...v1.0.0) (2026-06-12)


### Features

* agentless Flow Kit gate evaluation proof (issue [#52](https://github.com/kontourai/flow-agents/issues/52) item 3) ([f7857ec](https://github.com/kontourai/flow-agents/commit/f7857ec8ba69d614b0c3c70548d724f7a97c164a))
* agentless Flow Kit gate evaluation proof (issue [#52](https://github.com/kontourai/flow-agents/issues/52) item 3) ([86c881f](https://github.com/kontourai/flow-agents/commit/86c881f579a08ab75787cd32e401f83b77952c39))
* config-protection blocks git hook-skip flags ([#41](https://github.com/kontourai/flow-agents/issues/41)) ([6d9e981](https://github.com/kontourai/flow-agents/commit/6d9e9810b3d4e60fe172ade340e61dbe4053d0c9))
* K-level conformance, degradation invariant, and consumer-target derivation ([#52](https://github.com/kontourai/flow-agents/issues/52) items 1+2) ([d5c332a](https://github.com/kontourai/flow-agents/commit/d5c332a3f4400eb29e9f8fd4e845ec34cf30ae0b))
* K-level conformance, degradation invariant, and consumer-target derivation (issue [#52](https://github.com/kontourai/flow-agents/issues/52) items 1+2) ([6ac62eb](https://github.com/kontourai/flow-agents/commit/6ac62eb4cec195baca3d039b398f29e45e5d62de))
* **knowledge-kit:** obsidian layout — insights at node root, sources nested; dimension frontmatter ([5d6489b](https://github.com/kontourai/flow-agents/commit/5d6489b6dc30eacc3a4d0c51487c1a7d3a004f00))
* **knowledge-kit:** Obsidian store adapter — file-is-the-record spike ([#43](https://github.com/kontourai/flow-agents/issues/43)) ([83d9ff4](https://github.com/kontourai/flow-agents/commit/83d9ff43c2e1d59ac8d3235ae7250fc43be47725))
* **knowledge-kit:** Obsidian store adapter spike — file-is-the-record RATIFIED ([#43](https://github.com/kontourai/flow-agents/issues/43)) ([467c8dc](https://github.com/kontourai/flow-agents/commit/467c8dc60180a5f6bf15b30a4f0e29e486803fb8))
* **knowledge-kit:** person entity cards with backlinks + gated resolution ([#48](https://github.com/kontourai/flow-agents/issues/48)) ([9456cef](https://github.com/kontourai/flow-agents/commit/9456cef3b55c639bd50a9aeaea675bef425ea0be))
* **knowledge-kit:** person entity cards with backlinks + gated resolution ([#48](https://github.com/kontourai/flow-agents/issues/48)) ([ac5ccb0](https://github.com/kontourai/flow-agents/commit/ac5ccb08e40bb6adadd35ff165a617be29e8d23a))


### Fixes

* **entity-extractor:** parse trailing-period last-entry correctly ([76abd87](https://github.com/kontourai/flow-agents/commit/76abd87ce2e6bfa3650c3d20de7309d498a446f8))
* **entity-extractor:** parse trailing-period last-entry correctly ([#48](https://github.com/kontourai/flow-agents/issues/48)) ([ac64fc1](https://github.com/kontourai/flow-agents/commit/ac64fc1cb3151af9032948ac463337da3eeaf907))


### Documentation

* elevate Flow Kits as the authorable-ecosystem pillar ([#45](https://github.com/kontourai/flow-agents/issues/45)) ([fa81820](https://github.com/kontourai/flow-agents/commit/fa8182089c4e3c404e3020c6d516be93353a897b))
* elevate Flow Kits as the authorable-ecosystem pillar ([#45](https://github.com/kontourai/flow-agents/issues/45)) ([7ffa44e](https://github.com/kontourai/flow-agents/commit/7ffa44ea8be799e709b41d4ac4220948e3819fb8))
* kit container/extension layering — container contract is Flow-owned ([#50](https://github.com/kontourai/flow-agents/issues/50)) ([33d6ec0](https://github.com/kontourai/flow-agents/commit/33d6ec0bf0fefd9095c19dc76b995ee7dd8079fb))
* kit container/extension layering — container contract is Flow-owned ([#50](https://github.com/kontourai/flow-agents/issues/50)) ([fd87366](https://github.com/kontourai/flow-agents/commit/fd873663d64e205e1a8c2b898b913a56d410591f))


### Maintenance

* cut v1.0.0 ([5f88ac5](https://github.com/kontourai/flow-agents/commit/5f88ac51598fe3f13b16360572ff851b822013a2))

## [0.4.0](https://github.com/kontourai/flow-agents/compare/v0.3.0...v0.4.0) (2026-06-12)


### Features

* **knowledge-kit:** gated decision retirement + working-set exclusion (S7, [#37](https://github.com/kontourai/flow-agents/issues/37)) ([40ae3fb](https://github.com/kontourai/flow-agents/commit/40ae3fb483205da6cf349265a63245bd1bb4006b))
* **knowledge-kit:** vector similarity detector — first drop-in (I10 unparked) ([a63c6d4](https://github.com/kontourai/flow-agents/commit/a63c6d4eb122d86cf14f018dc23651043be6449a))


### Fixes

* **ci:** author release PRs via kontour-release-bot app token ([#38](https://github.com/kontourai/flow-agents/issues/38)) ([6a2c937](https://github.com/kontourai/flow-agents/commit/6a2c9376df0c07458e54066108ec17e3c9548841))


### Documentation

* repo commit/release conventions in AGENTS.md, pinned by static check ([aecd896](https://github.com/kontourai/flow-agents/commit/aecd896fb2c4a86ebe51749c2257e7b41b9cbc21))

## [0.3.0](https://github.com/kontourai/flow-agents/compare/v0.2.0...v0.3.0) (2026-06-12)


### Features

* **knowledge-kit:** concept synthesis with evidence-gated mutations (S3, [#34](https://github.com/kontourai/flow-agents/issues/34)) ([f307165](https://github.com/kontourai/flow-agents/commit/f30716503b22202d8929876b3e0b5d0d4bcbd2cb))
* **knowledge-kit:** decision-snapshot consolidation, supersede-not-delete (S6, [#36](https://github.com/kontourai/flow-agents/issues/36)) ([7211605](https://github.com/kontourai/flow-agents/commit/7211605fd19a0a332b7816c1fb0e66259771c3ba))
* **knowledge-kit:** ingest/classify + compile flows with provenance gates (S2, [#33](https://github.com/kontourai/flow-agents/issues/33)) ([07dffd5](https://github.com/kontourai/flow-agents/commit/07dffd5f6c6ab8555fc8c7e029d6432cd854dd05))
* **knowledge-kit:** keyless live example + acceptance harness (S5, [#35](https://github.com/kontourai/flow-agents/issues/35)) ([9a565aa](https://github.com/kontourai/flow-agents/commit/9a565aaa8deac236f07b63933bb8ce6887ac25f9))
* **knowledge-kit:** store contract + default reference adapter (S1, [#31](https://github.com/kontourai/flow-agents/issues/31)) ([4ed06ba](https://github.com/kontourai/flow-agents/commit/4ed06ba7cad7865094feddf0bd5ac7f76639b9ed))
* strands-local kit activation — framework-path kits (S4, [#32](https://github.com/kontourai/flow-agents/issues/32)) ([8dc05ec](https://github.com/kontourai/flow-agents/commit/8dc05ecf810dc3d205046c4773aa2c1e62159acb))


### Fixes

* dedup pi session.start; document opencode run-mode session.created gap ([4d7e5b1](https://github.com/kontourai/flow-agents/commit/4d7e5b1e2de6573b824852598b04a5da3485adf6))
* telemetry-doctor reported the workspace parent as the local sink dir ([e15d7b2](https://github.com/kontourai/flow-agents/commit/e15d7b2e922225e4c30a39fceea304ca01e5ac17))


### Documentation

* Flow Kits authoring guide, README kits section, npx command forms ([a89a86c](https://github.com/kontourai/flow-agents/commit/a89a86cc488abb7f6cd3cd300a67044174afa154))

## [0.2.0](https://github.com/kontourai/flow-agents/compare/v0.1.2...v0.2.0) (2026-06-11)


### Features

* engine contract 1.0, conformance kit, Strands rebind, integration docs ([fd94f58](https://github.com/kontourai/flow-agents/commit/fd94f583f52c874d901e06da0ee338830b3d469a))
* install lifecycle tests, dogfood command, collision marker fix ([a0fb2e3](https://github.com/kontourai/flow-agents/commit/a0fb2e31d897426db435801c8a637a9736d99ad1))
* live acceptance harnesses for opencode and pi ([181382b](https://github.com/kontourai/flow-agents/commit/181382b8dfe05cce41c0471a030e7d795950cd09))
* Strands TypeScript adapter — first native-import engine consumer ([0f387ab](https://github.com/kontourai/flow-agents/commit/0f387ab8e5a8b7f65e511af2fc33340f51e2d047))
* weekly runtime/SDK compatibility canary + dependabot ([9a371b1](https://github.com/kontourai/flow-agents/commit/9a371b1af86394fe1f7febebe3a35d3f05321f8e))


### Fixes

* opencode.json — emit schema-valid config (instructions must be array) ([35a01ec](https://github.com/kontourai/flow-agents/commit/35a01ec508b2f99d4a7bca854e5f09740bac4fb3))
* opencode/pi hook chain — node resolution, stdin payloads, telemetry escape ([be4e4f8](https://github.com/kontourai/flow-agents/commit/be4e4f8d3b81fc7b67d6e45f4c9c1515407268a7))
* pi extension template escaping; parse-gate generated hook artifacts ([6fe40c5](https://github.com/kontourai/flow-agents/commit/6fe40c5079b8ee89a58c4dfecd6df2992c46cf59))


### Documentation

* roadmap rows reflect the shipped utterance evidence-check hook ([#24](https://github.com/kontourai/flow-agents/issues/24)) ([617c755](https://github.com/kontourai/flow-agents/commit/617c75567b692c02564f457577d1ab3c01c1ea8e))

## 0.1.2

- Source validation resolves the Flow CLI at `dist/cli.js` (with a
  `src/cli.js` fallback), and the source-and-static CI lane installs
  `@kontourai/flow` so kit Flow Definitions are validated by the real
  Flow CLI.
- The publish workflow builds the bundle explicitly before `npm publish`.
- Docs routing between the System Guidebook and the Workflow Usage Guide;
  duplicated development walkthrough removed.
- README and Pages home advertise the npm install with the version badge;
  pre-release caveats removed; Kontour family table links product pages
  and gains a Survey row.
- Fixes phantom skill references, a stale pack list, and path accuracy in
  the docs.

## 0.1.1

### Documentation And Site

- Rewrote the README and GitHub Pages home with a verified install path
  (checkout-based; npm publishing is on the roadmap), the Kontour product-line
  story, and cross-links to the Kontour Flow documentation.
- Rebranded the docs site to the shared Kontour design tokens: Fraunces,
  Hanken Grotesk, and IBM Plex Mono, the Flow teal accent, light/dark themes,
  a version badge, OG/social meta tags, and a favicon.
- Fixed mobile navigation: the rail is now an accessible slide-over drawer
  instead of disappearing below 860px.
- Added frontmatter to fourteen docs (including the workflow usage guide,
  skills map, and all ADRs) so Jekyll renders them as pages instead of copying
  raw Markdown, and enabled the github-pages default plugins locally for
  build parity.
- Merged the evidence reference migration note into `docs/migrations.md`,
  merged the roadmap into `docs/north-star.md`, and retired
  `docs/release-notes.md` in favor of this changelog.

### Packaging And Cross-Product Validation

- Made the package publishable: removed the `private` flag, added the license
  and public `publishConfig`, a `prepack` validation lane, and a tag-triggered
  `Publish NPM` workflow using npm trusted publishing, mirroring the Flow
  release pipeline.
- Fixed Flow CLI integration in source validation: `FLOW_CLI_ROOT` now resolves
  the compiled `dist/cli.js` (with a `src/cli.js` fallback), and the
  source-and-static CI lane installs `@kontourai/flow` so kit Flow Definitions
  are validated by the real Flow CLI in CI.
- Removed the broken `build-docs-preview` tool and its wrapper, bin, and script
  entries; local docs preview is now documented in CONTRIBUTING.md using the
  same Jekyll setup as the Pages workflow.

### Repository Cleanup

- Consolidated TypeScript tooling source under `src/tools/` and kept
  `scripts/` as the public wrapper/runtime surface.
- Documented repository structure, generated-output boundaries, runtime hook
  boundaries, and safe cleanup rules.
- Removed stale local runtime artifacts and corrected package metadata drift.

### Codex Runtime Hooks

- Reinstalled Codex into an isolated Flow Agents home and fixed generated
  Codex hook commands to prefer `CODEX_HOME`.
- Documented the stale repo-local `.codex/hooks.json` failure mode that caused
  Codex `PostToolUse` to reject Claude-only `suppressOutput` output.

### CI And Release Readiness

- Enabled permanent TypeScript unused-code enforcement with `noUnusedLocals`
  and `noUnusedParameters`.
- Made the Node runtime policy explicit: package metadata requires Node `>=22`,
  CI runs Node 22, and `@types/node` stays on the Node 22 major line until
  runtime policy changes.
- SHA-pinned GitHub Actions with version comments, including dereferencing the
  annotated `actions/checkout@v6.0.3` tag to its commit SHA.
- Split Flow Agents CI into independent source/static, workflow-contract, and
  runtime/kit lanes with separate evidence artifacts.
- Preserved fail-closed CI evidence finalization: failed, missing, duplicate,
  or invalid check rows fail the corresponding CI lane.
- Verified the npm lockfile with a clean audit and updated `promptfoo` to
  `0.121.15`.
