# Changelog

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
