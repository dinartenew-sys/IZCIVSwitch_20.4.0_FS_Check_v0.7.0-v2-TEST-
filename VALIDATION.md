# Validation of v0.7.0

Target: user-reported Switch 2 firmware 20.4.0, Civ7 Switch 1 cartridge v1.0.0.
Pinned upstream commit: 6466918d6346aa0b5965fa0d44729235c4d94b14.

Hardware evidence already received:

- v0.5 engine-check-20261112T020534009Z: application stages passed, fourteen
  joined worker executions, and complete native and bridge cleanup.
- v0.6.0: seven-file save backup verified (1,288,670 bytes), then setup cloning
  blocked before any native FS race wave.
- v0.6.2: releasing an idle session after a clone blocked did not unblock it.
- v0.6.3 session-check-20261112T162544745Z: eight clones and two pointer-buffer
  queries passed, peak eleven owned FS handles, all requests joined and resources
  released, 631 bridge exchanges. No acquisition or save writes were attempted.

Offline validation covers 50 tests:

- Existing bridge framing, SDK gating, dynamic frames, ownership, application
  worker checks and host/bridge version agreement.
- Save backup bytes, checksums, second console reads, incomplete manifests,
  path/size bounds and prevention of acquisition after backup failure.
- Independent captured memory-proof verification, rejection of changed neighbors
  or incomplete restoration, and cooperative stop checkpoints.
- Monitored controls: reads only after join, handle ownership, pending and
  uncertain-launch retention, refused-launch cleanup, transport failures and
  rejection of unowned sources or unsupported controls.
- Compact setup: seven clones, ten distinct sessions, separate concurrent
  roles and rejection of duplicate handles.
- Staged runtime imports without network access, including rejection when the
  memory/session.cjs dependency is removed.
- Actual acquisition entrypoint with mocked native operations: blocked cloning
  causes no scratch path calls and retains resources. Successful full setup
  reaches its first scratch write only after ten sessions qualify and the
  metadata copy and monitor are released.

All CommonJS syntax is checked. Build-only stages/imports runtime dependencies
and compiles the payload without a connection. Distributed upstream inputs are
checked against their pinned Git blob identities. The ZIP has a complete SHA-256
manifest and archive integrity check.

Offline tests use mocks and fixtures. v0.7.0 has not run on the console. The
larger connection setup, FS read/write/restoration proof, later native stages,
complete port and sustained reliability remain unverified.

## Layout and filler-topology diagnostics (2026-11-13, not in the release)

Hardware runs (Layout A unless noted):

- Layout C, setup only (`NS2_DIAG_STOP_AT_SCRATCH=1`): stopped at `before scratch
  writes` with ten sessions and the trigger from the separate copy. No scratch
  write was made.
- Layout C, full (`run-20261113T145641628Z`): scratch writes made and cleaned up,
  restoration checks passed, no marker hit in 14 executed waves, no address proof.
  Successful triggers completed 42 µs after the canary ended.
- Layout A, full (`run-20261113T150036689Z`): scratch writes made and cleaned up,
  restoration checks passed, no marker hit in 21 executed waves. Successful
  triggers completed 32 to 505 µs after the canary ended. Under the proposal's
  stop rule, Layout C matches Layout A on timing; Layout C has one successful
  trigger, so the match is thin.
- Filler topology (`NS2_DIAG_FILLER_ROLES=1`: filler0, filler1 and guard0
  restored in upstream's positions), two attempts (`run-20261113T151519795Z`,
  `run-20261113T152828967Z`): the monitored clone requests completed in order up
  to `Clone guard1`, which brought owned FS handles to 12. The next request,
  `Clone trigger`, was issued at 12 owned handles and never returned. The clone
  monitor reported it as not terminated within 2500 ms, with cleanup not reported.
  No wave started and no scratch file was written.

The filler topology needs thirteen owned sessions at setup, and its last clone
request always runs at twelve owned handles. That is the condition under which
v0.6.3 stalled, so the filler topology cannot be tested within the twelve-handle
limit. The compact ten-session setup remains the supported layout. The
`NS2_DIAG_FILLER_ROLES` switch stays available as an opt-in diagnostic only.

Whether the trigger's extent-present result depends on the filler roles remains
untested. Upstream's reference result for `extent-present` (returns 0 on its save)
has not been reproduced on this console with either layout.
