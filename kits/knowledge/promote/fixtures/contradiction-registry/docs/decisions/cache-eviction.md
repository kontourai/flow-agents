---
status: current
subject: Cache eviction policy
decided: 2026-06-25
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/415
---

# Cache eviction policy

Entries are evicted using a least-frequently-used (LFU) policy.
