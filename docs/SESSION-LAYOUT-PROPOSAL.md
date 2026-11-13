# Session layout proposal (offline, no console time)

Status: proposal for review. Nothing here is implemented or tested on hardware.

## Problem

- The race needs the trigger to land while the canary is still pending and the hole read is in progress.
- Early triggers (sent before the hole finishes) that are not aborted complete 39 to 1,609 us after the canary finishes, in all 14 cases seen. None lands inside the canary window. This is consistent with the trigger being serialized behind the commit or the canary.
- The trigger is currently a clone of `saved` (`compact-clients.cjs:21`). Temporary is an alias of `saved` (`probe-reserved-gap.cjs:254`).
- Peak owned FS handles in the current layout is 12 (10 at setup, plus pin and candidate during waves). The earlier v0.7 stall happened with 12 owned handles and a clone request pending. Going above 12 is not acceptable until that stall is understood.

## Constraints

- Peak owned handles at or below 12, at setup and during waves.
- Concurrent roles keep distinct connections (handoff rule).
- Save backup, ownership, join and restoration guards stay as they are.

## Layouts considered

| Layout | Setup handles | Wave handles | Trigger object | Status |
| --- | --- | --- | --- | --- |
| A. Current | 10 | 12 | clone of `saved` | Baseline. Tested on hardware: no hit. |
| B. Swap commit and trigger | 10 | 12 | `saved`; commit is a clone | Low value. Only tests whether the base handle versus a clone changes timing. Commit-from-clone has not run on hardware. |
| C. Separate temporary copy as trigger | 10 | 12 | separate `cloneMountedFilesystem` copy (not an alias), no trigger clone | Recommended first test. Same handle count as A. |
| D. Upstream topology | 11 | 13 | separate temporary plus trigger clone of temporary | Rejected. Exceeds 12. Dropping a tail or guard to fit would change the race. Merging canary and guard1 breaks the separate-connection rule. |
| E. Root-sourced trigger | 10 | 12 | clone of root | Rejected. Fails at the native send with 62977 (0xF601), in two runs. |

## Recommended test: Layout C

Change, behind a diagnostic switch (default off):
- Create a separate temporary copy with `cloneMountedFilesystem` instead of aliasing `saved`.
- Send the trigger from that temporary object.
- Do not create the trigger clone, so the setup count stays at 10.

Expected handle count: setup 10, waves 12. Clone requests run at owned counts 4 to 9, below the 12-handle stall level.

Evidence needed from the run:
- Trigger `startUs` and `endUs` against the commit and canary rows.
- Whether the trigger completes before the canary ends. This would support per-object serialization.
- Whether the trigger still completes shortly after the canary ends. This would suggest serialization at the device level shared by all copies, in which case no layout within 12 handles can separate the trigger from the commit.

## Unknowns (not verified in code)

- Whether clones and copies share a single implementation object or lock.
- Whether a native send from a temporary copy behaves the same as from a clone.
- Whether the control 3 pointer query works on the temporary copy (`probe-reserved-gap.cjs:277`).
- Whether restoration (heap drift up to 1024 bytes) still holds when a copy allocates differently from a clone.
- Canary completion also precedes trigger completion, so the serialization domain may include the canary, not only the commit.

## Stop rule

If Layout C shows the same timing as Layout A, stop hardware work on the session layout. The remaining explanation is device-level serialization, and the next step would be a different race model, not a different session layout.

## Open decisions for review

1. ~~Approve Layout C as the next hardware test.~~ **APPROVED (2026-11-13).** Layout C is the next hardware test.
2. Confirm the diagnostic switch name and default-off behaviour. **Implemented (pending confirmation):** `NS2_DIAG_SESSION_LAYOUT=C` selects Layout C; unset or `A` keeps the current layout. Layout C rejects `NS2_DIAG_TRIGGER_SOURCE=root`.
3. Confirm that the early-send switch (`NS2_DIAG_TRIGGER_EARLY=1`) should be used with Layout C, so the trigger timing is directly comparable with the earlier runs.
