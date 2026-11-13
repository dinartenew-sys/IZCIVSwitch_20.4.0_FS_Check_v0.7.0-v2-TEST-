# IZCIVSwitch 20.4.0 filesystem memory check v0.7.0

Your v0.6.3 session check passed all eight clone requests and both pointer-buffer
queries after unused setup connections were released early. All workers joined
and resources were released. Earlier FS attempts stalled during setup cloning,
before any filesystem race wave or overwrite.

This package applies that connection-management approach to the full FS check.
The complete setup needs ten clones and thirteen distinct sessions. That larger
layout still needs hardware validation: v0.6.3 reached eleven owned FS handles
and does not establish a firmware limit. The full port remains unverified.

## Run

1. Extract the ZIP into a new folder. Keep at least **512 MiB free on your PC**.
2. Restart the console, use your existing isolated Ethernet setup, and launch
   your existing CivSwitch trigger. Wait for **Awaiting payload at 192.168.77.2:9026**.
3. Double-click **RUN_FS_CHECK.cmd**.
4. Keep both the game and the command window open until it finishes. The first
   part backs up your save and qualifies connections before scratch writes. The
   acquisition then has a ten-minute
   checkpoint deadline, followed by time for cleanup.
5. Upload the resulting **fs-check-....json** and **fs-check-....log** from `reports`.

Keep the whole extracted folder, including the backup in
`reports/run-.../engine/switch2/save-backup`. Its manifest maps each numbered
`.bin` file to its original save path and records the checksum.

To request an early stop, double-click **STOP_FS_CHECK.cmd** and leave the main
checker running. It requests a stop at the next checkpoint so restoration can
finish. If the game freezes or the result requests a restart, restart the console
before another attempt and keep the reports and backup.

If your console uses another private address, run:

```powershell
node .\run_fs_check.cjs --host 192.168.77.2
```

Node.js 20 or newer is required; your PC already has Node installed. No npm
packages or internet access are required. The working v0.5 transport is retained:
the existing loader on console TCP 9026, one temporary console listener on TCP
9027 and a PC relay bound to 127.0.0.1. No firewall or network settings are changed.

## What runs

The checker verifies the same 61 SDK signatures and full code checksum, pairs
the native bridge and restores its scratch challenge. It inspects the current
mounts before copying the save filesystem session. Borrowed sessions are not
closed; only handles returned for owned copies are closed.

Before making scratch changes, it copies every save file to the PC, verifies the
saved bytes against SHA-256, and reads each console file a second time. A failed
or incomplete backup stops the run before acquisition. The copy is bounded to
256 MiB, 10,000 entries and 32 directory levels.

Before any scratch write, the owned RomFS metadata copy is closed after its size
comparison. The base save handle also serves the commit worker. Ordinary host
operations finish before waves start. Both sequential trigger paths share one
trigger handle, while concurrent roles keep separate connections.

Each clone or pointer-buffer control runs on a monitored worker using the
v0.6.3 event/frame/stack layout. A pending request stops the attempt after its
2.5-second join budget. Its buffers, worker and source resources stay allocated
until console restart; the loader can still finish reporting and bridge shutdown.
No reply is read before kernel termination. No spare session is released after
a request blocks. The monitor is freed before filesystem waves begin.

The monitor covers cloning and pointer-buffer controls only. Ordinary save I/O
and native FS waves retain their existing IPC, timing and geometry. The package
also checks staged runtime imports before opening a console connection.

One instance of the pinned upstream `probe-reserved-gap.cjs` then runs, with its
existing bounded internal waves and geometry checks. It creates a unique
`/NS2_GAP_...` directory in the game's save, performs the acquisition controls,
and, if they qualify, challenges a 16 KiB FS memory block with a 16-byte marker.
It checks the changed block and restores the original bytes before retiring the
temporary cache entry and deleting and committing removal of its scratch folder.

The run skips the optional memory server and its diagnostic idle delay. It does
not proceed to RO/PM payload launch or filesystem code execution. A failed
acquisition is not automatically launched again.

**The attempt writes dedicated scratch files and changes filesystem process
memory. A crash or interruption can leave incomplete restoration or save
changes.** The verified PC backup is retained for recovery; do not delete it.

## Results

**FS_MEMORY_CHECK_PASSED** requires all of the following:

- Verified complete save backup and cleanup of its owned native resources.
- Successful independent verification of both captured memory reads, the exact
  marker write, unchanged neighboring bytes and the restored full block.
- Retired temporary cache entry, unchanged backing content, removed scratch
  files and complete acquisition cleanup.
- Clean console bridge termination and release of its sockets and allocations.

The summary JSON records the failing control if the inherited FS profile differs
on 20.4.0. The full `reserved-gap-....json`, captured proof bytes and native worker
plans remain in the run folder for further diagnosis. No unverified replacement
firmware offsets have been invented.

Passing this check establishes only the bounded FS memory proof in that run.
The full port, later native helper stages and sustained reliability still need
hardware validation.

## Source and validation

Source is pinned to `byizmysh/IZCIVSwitch` revision
`6466918d6346aa0b5965fa0d44729235c4d94b14`. This is a separate local package.
`SOURCE-INPUTS.json`, `ADAPTATIONS.md`, `VALIDATION.md` and `SHA256SUMS` identify
its inputs, changes and checks. The GPL-2.0 and MIT licenses and attribution are
in `upstream-notices`.

```powershell
node --test .\tests\*.test.cjs
node .\run_fs_check.cjs --build-only
```
