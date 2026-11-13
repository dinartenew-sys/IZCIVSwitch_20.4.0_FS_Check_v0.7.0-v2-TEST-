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
