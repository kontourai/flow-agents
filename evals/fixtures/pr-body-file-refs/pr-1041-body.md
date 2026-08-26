## Summary

- replace provider-lock sleep timing with fixture-local entered/release barriers and bounded cleanup
- replace staged trust-bundle fs.watch timing with an exact synchronous snapshot boundary
- prebuild shared bundles before parallel unit tests and isolate intentional bundle rebuild output
- make the board-sync no-CLI fixture remove inherited and planted `flow-agents` executables deterministically

## Verification

- focused provider, staged-bundle, universal-bundle, and no-CLI board-sync regressions: PASS
- prior exact-head unit lane: 1,312 tests, 1,296 passed, 16 skipped, 0 failed
- fresh full manifest-listed static verification is tracked by #1045 at exact head `f97ceb0dd4d665bb7e5799712e28c139276196d8`
- exact diff: four test-infrastructure files

Closes #1029
Closes #1030
Closes #1036
Closes #1037
Closes #1040
Closes #1045
