/*
 * civ_bridge.js â€” ns2jb wire-protocol console bridge for the CivSwitch (Civ 7) loader.
 *
 * Eval'd inside the CivSwitch loader closure (TCP :9026); all BRIDGE-CONTRACT.md Â§1
 * primitives (read64/write64/.../call_rop/malloc/free/socket family/log) are in scope.
 *
 * Implements BRIDGE-CONTRACT.md Â§2 exactly:
 *   - listen temporarily on the console LAN address at TCP 9027
 *   - send 128-byte HELLO (16 x u64 LE)
 *   - RPC loop: recv exactly 0x8080 bytes into scratch+0x40000,
 *     execute record A [+0x00] then record B [+0x28] via call_rop(fn, a0, a1, a2, a3),
 *     write resultB at scratch+0x4030 and resultA at scratch+0x4038,
 *     send exactly 0x8010 bytes from scratch+0x4030.
 *   - record A first 20 bytes all zero => clean shutdown.
 *
 * SAFETY: this payload only ever touches (a) memory it malloc'd, (b) addresses
 * derived from svcQueryMemory results, and (c) addresses supplied by the PC engine
 * inside RPC records. No blind pointer chasing: an unmapped read/write is a
 * hardware fault and is NOT catchable from JS â€” it would kill the game process.
 *
 * The bridge occupies the loader eval for its entire lifetime (long-running);
 * log() lines keep streaming back over the loader's :9026 client connection.
 */
(async function () {
  // ============================ CONFIG ============================
  // Edit before deployment, or keep defaults and let runtime resolution run.
  const CONFIG = {
    // --- Console endpoint (the PC connects in) ---
    PC_IP: '__CONSOLE_HOST__',   // replaced by the local launcher
    PC_PORT: 9027,           // ns2jb default

    // --- HELLO fields (u64). 0n = "auto-resolve at runtime" where supported ---
    SCRATCH: 0n,        // 0 => malloc(0x80000)
    MAIN: 0n,           // 0 => svcQueryMemory region base containing main_base anchor
    SDK: 0n,            // 0 => svcQueryMemory region base containing sdk_base anchor
    GOT: 0n,            // unused by the Civ7 engine target
    MEMMOVE: 0n,        // 0 => resolved sdk text base + 0x522830
    BACKING: 0n,        // unused by the Civ7 engine target
    CONTROLLER: 0n,     // keep-awake is disabled for Civ7
    SDK_CRC32: 157086863n, // zlib CRC-32 of the 0x602000-byte Civ7 sdk text

    // --- svcQueryMemory wrapper (absolute). 0n => pattern-scan for it ---
    // In the dumped session it sat at sdk_text_base + 0x168B0C (stable per build).
    QMFUNC: sdk_base + 0x168B0Cn,

    VERBOSE: false,     // log a line every 1000 RPCs
  };
  // ================================================================

  const SCRATCH_BYTES   = 0x80000n;
  const REQUEST_BYTES   = 0x8080;   // console <- PC
  const RESPONSE_BYTES  = 0x8010;   // console -> PC
  const INPUT_OFF       = 0x40000n; // request lands at scratch+0x40000
  const REC_B_OFF       = 0x28n;    // record B inside request
  const RESULT_B_OFF    = 0x4030n;  // response[0:8]  = second call result
  const RESULT_A_OFF    = 0x4038n;  // response[8:16] = first  call result
  const HELLO_MAGIC     = 0x31545344n;
  const HELLO_VERSION   = 1n;
  const HELLO_PLATFORM  = 2n;       // 2 = Switch 2

  const hex = v => '0x' + BigInt(v).toString(16);

  // ---- sock helpers (wrappers return signed-32 BigInt; <=0 means fail/EOF) ----
  async function sendAll(fd, addr, len) {
    let off = 0;
    while (off < len) {
      const r = send(fd, addr + BigInt(off), len - off, 0);
      if (r <= 0n) { await log('send failed mid-stream: ret=' + r + ' at ' + off + '/' + len); return false; }
      off += Number(r);
    }
    return true;
  }
  async function recvFull(fd, addr, len) {
    let off = 0;
    while (off < len) {
      const r = recv(fd, addr + BigInt(off), len - off, 0);
      if (r <= 0n) { await log('recv ended: ret=' + r + ' after ' + off + '/' + len + ' bytes'); return false; }
      off += Number(r);
    }
    return true;
  }

  let scratch = 0n;
  let scratchOwned = false;
  const verifiedAllocations = new Set();
  let aux = 0n;
  let fd = -1n, listener = -1n;
  let terminated = false, rpcCount = 0;
  const cleanupErrors = [];
  const finalReport = {tool:'izcivswitch-engine-bridge', checkerVersion:'0.7.0', requestedFirmware:'20.4.0', cleanupComplete:false};
  try {
    await log('=== civ_bridge: ns2jb console bridge starting ===');

    // ---- 1. scratch buffer (0x80000) ----
    scratch = CONFIG.SCRATCH;
    if (scratch === 0n) {
      scratch = malloc(Number(SCRATCH_BYTES));   // calloc-backed => zeroed
      scratchOwned = true;
    }
    if (!scratch) { await log('FATAL: malloc(0x80000) failed'); return; }
    await log('scratch = ' + hex(scratch) + ' (' + (scratchOwned ? 'malloc' : 'CONFIG') + ')');

    // Aux buffers live OUTSIDE scratch so the RPC areas stay pristine.
    aux = malloc(0x400);   // calloc-backed => zeroed
    if (!aux) { await log('FATAL: malloc(0x400) failed'); return; }
    const saBuf    = aux;             // 16-byte sockaddr_in
    const helloBuf = aux + 0x40n;     // 128-byte HELLO
    const infoBuf  = aux + 0x100n;    // svcQueryMemory MemoryInfo out (0x20 used)
    const pageBuf  = aux + 0x140n;    // svcQueryMemory page-info out (8)

    // ---- 2. locate the svcQueryMemory wrapper inside the sdk module ----
    // Pattern (BRIDGE-CONTRACT.md Â§1): str x1,[sp,#-16]! (0xF81F0FE1) ; svc #6 (0xD40000C1)
    const STRX1 = 0xF81F0FE1n, SVC6 = 0xD40000C1n;
    let qmFunc = CONFIG.QMFUNC;
    if (qmFunc === 0n) {
      await log('scanning [sdk_base, sdk_base+0x5F0000) for svcQueryMemory wrapper...');
      let prevHi = 0n;               // carry high word to catch 4-byte (non-8) alignment
      const scanEnd = sdk_base + 0x5F0000n;
      for (let a = sdk_base; a < scanEnd; a += 8n) {
        const pair = read64(a);
        const lo = pair & 0xffffffffn, hi = pair >> 32n;
        if (lo === STRX1 && hi === SVC6) { qmFunc = a; break; }       // start at a
        if (prevHi === STRX1 && lo === SVC6) { qmFunc = a - 4n; break; } // start at a-4
        prevHi = hi;
      }
      if (qmFunc === 0n) { await log('FATAL: svcQueryMemory wrapper not found'); return; }
    }
    await log('svcQueryMemory wrapper = ' + hex(qmFunc));

    // ---- 3. region query helper ----
    function query(addr) {
      const r = call_rop(qmFunc, infoBuf, pageBuf, addr);
      if (r !== 0n) return null;
      return {
        base: read64(infoBuf), size: read64(infoBuf + 8n),
        type: Number(read32(infoBuf + 0x10n)), perm: Number(read32(infoBuf + 0x18n)),
        attributes: Number(read32(infoBuf + 0x14n)), ipcReferences: Number(read32(infoBuf + 0x1cn)), deviceReferences: Number(read32(infoBuf + 0x20n)),
      };
    }

    // ---- 4. resolve true module bases for HELLO ----
    let sdk = CONFIG.SDK;
    if (sdk === 0n) {
      const t = query(sdk_base);
      if (!t) { await log('FATAL: svcQueryMemory(sdk_base) failed'); return; }
      sdk = t.base;
      await log('sdk region : ' + hex(t.base) + ' + ' + hex(t.size) +
                ' type=' + t.type + ' perm=' + t.perm + ((t.perm & 4) ? '' : '  (WARN: not executable!)'));
    }
    let main = CONFIG.MAIN;
    if (main === 0n) {
      const t = query(main_base);
      if (!t) { await log('FATAL: svcQueryMemory(main_base) failed'); return; }
      main = t.base;
      await log('main region: ' + hex(t.base) + ' + ' + hex(t.size) +
                ' type=' + t.type + ' perm=' + t.perm + ((t.perm & 4) ? '' : '  (WARN: not executable!)'));
    }

    // Bind only the specified console LAN address; the PC connects outward.
    function owned(base, bytes) {
      const r = query(base);
      return r && r.base <= base && base + BigInt(bytes) <= r.base + r.size &&
        r.type === 5 && r.perm === 3 && r.attributes === 0 &&
        r.ipcReferences === 0 && r.deviceReferences === 0;
    }
    if (owned(scratch, Number(SCRATCH_BYTES))) verifiedAllocations.add(scratch);
    if (owned(aux, 0x400)) verifiedAllocations.add(aux);
    if (!verifiedAllocations.has(scratch) || !verifiedAllocations.has(aux))
      throw Error('Bridge allocation is not ordinary owned memory');
    const ipParts = CONFIG.PC_IP.split('.').map(Number);
    if (ipParts.length !== 4 || ipParts.some(v => !Number.isInteger(v) || v < 0 || v > 255))
      throw Error('Invalid console address');
    const port = CONFIG.PC_PORT;
    write8(saBuf, 16n); write8(saBuf + 1n, 2n);
    write16(saBuf + 2n, BigInt(((port & 255) << 8) | (port >> 8)));
    write32(saBuf + 4n, BigInt(ipParts[0] + ipParts[1]*256 + ipParts[2]*65536 + ipParts[3]*16777216));
    listener = socket(2n, 1n, 0n);
    if (listener < 0n) throw Error('Temporary socket failed');
    if (bind(listener, saBuf, 16n) !== 0n || listen(listener, 1n) !== 0n)
      throw Error('Temporary console listener failed');
    await log('IZ20_ENGINE_READY');
    fd = accept(listener, 0n, 0n);
    if (fd < 0n) throw Error('Temporary console accept failed');
    if (close(listener) !== 0n) throw Error('Temporary listener close failed');
    listener = -1n;

    // ---- 6. build + send the 128-byte HELLO (16 x u64 LE) ----
    const memmove = CONFIG.MEMMOVE === 0n ? sdk + 0x522830n : CONFIG.MEMMOVE;
    const helloFields = [
      HELLO_MAGIC, HELLO_VERSION, HELLO_PLATFORM,
      scratch, SCRATCH_BYTES, main, sdk,
      CONFIG.GOT, memmove, CONFIG.BACKING, CONFIG.CONTROLLER,
      0n, 0n, 0n, 0n, CONFIG.SDK_CRC32,
    ];
    for (let i = 0; i < 16; i++) write64(helloBuf + BigInt(i * 8), helloFields[i]);
    await log('HELLO: scratch=' + hex(scratch) + ' main=' + hex(main) + ' sdk=' + hex(sdk) +
              ' got=' + hex(CONFIG.GOT) + ' memmove=' + hex(memmove) +
              ' backing=' + hex(CONFIG.BACKING) + ' controller=' + hex(CONFIG.CONTROLLER) +
              ' sdkCrc32=' + hex(CONFIG.SDK_CRC32));
    if (CONFIG.GOT === 0n)
      await log('NOTE: got is unused by the Civ7 target; backing/controller remain zero.');
    if (!(await sendAll(fd, helloBuf, 128))) return;
    await log('HELLO sent; entering RPC loop');

    // ---- 7. RPC loop (BRIDGE-CONTRACT.md Â§2) ----
    const inBuf = scratch + INPUT_OFF;

    let skippedNull = false;
    for (;;) {
      if (!(await recvFull(fd, inBuf, REQUEST_BYTES))) break;

      // Termination: record A's first 20 bytes (fnAddr + a0 + low half of a1) all zero.
      if (read64(inBuf) === 0n && read64(inBuf + 8n) === 0n && read32(inBuf + 16n) === 0n) {
        terminated = true; await log('termination record received');
        break;
      }

      let resultA = 0n, resultB = 0n;

      const fnA = read64(inBuf);
      const b = inBuf + REC_B_OFF;
      const fnB = read64(b);
      if (fnB === 2n) {
        if (fnA !== 0n && fnA % 4n === 0n) {
          try {
            resultA = call_rop(fnA, read64(inBuf + 8n), read64(inBuf + 16n),
                                    read64(inBuf + 24n), read64(inBuf + 32n),
                                    read64(b + 8n), read64(b + 16n));
          } catch (e) { throw Error('Six-argument call failed: ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await log('WARN: invalid six-argument continuation â€” skipped'); }
      } else {
        // Record A (request+0x00). Defensive: a zero fn with non-zero args is not
        // the termination packet but is still not callable â€” skip instead of
        // jumping to address 0 (which would fault the process).
        if (fnA !== 0n) {
          try {
            resultA = call_rop(fnA, read64(inBuf + 8n), read64(inBuf + 16n),
                                    read64(inBuf + 24n), read64(inBuf + 32n));
          } catch (e) { throw Error('Record A call failed: ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await log('WARN: record A fn=0 (not the termination packet) â€” skipped'); }

        // Record B (request+0x28). The engine always pads single-call exchanges
        // with a memmove(output,output,0,0) no-op; if a peer leaves fn=0, skip.
        if (fnB !== 0n) {
          try {
            resultB = call_rop(fnB, read64(b + 8n), read64(b + 16n),
                                    read64(b + 24n), read64(b + 32n));
          } catch (e) { throw Error('Record B call failed: ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await log('WARN: record B fn=0 â€” skipped (engine should pad with a no-op)'); }
      }

      // Response header: resultB first, then resultA (matches bootstrap.bas and
      // native.cjs, where response[0:8] = second call, response[8:16] = first).
      write64(scratch + RESULT_B_OFF, resultB);
      write64(scratch + RESULT_A_OFF, resultA);

      if (!(await sendAll(fd, scratch + RESULT_B_OFF, RESPONSE_BYTES))) break;

      rpcCount++;
      if (CONFIG.VERBOSE && rpcCount % 1000 === 0) await log('rpc: ' + rpcCount + ' exchanges');
    }

    await log('=== civ_bridge: exiting after ' + rpcCount + ' RPC exchanges ===');
  } catch (e) {
    // Never let a JS exception kill the eval silently â€” report and return.
    try { await log('FATAL bridge exception: ' + ((e && e.stack) || e)); } catch (_) {}
  } finally {
    for (const descriptor of [fd, listener]) if (descriptor >= 0n) {
      try { if (close(descriptor) !== 0n) cleanupErrors.push('socket close failed'); }
      catch (e) {cleanupErrors.push(String(e));}
    }
    for (const address of [aux, scratchOwned ? scratch : 0n]) if (address) {
      if (!verifiedAllocations.has(address)) {cleanupErrors.push('unverified bridge allocation retained: ' + hex(address));continue;}
      try {free(address);} catch (e) {cleanupErrors.push(String(e));}
    }
    finalReport.terminated = terminated;
    finalReport.rpcCount = rpcCount;
    finalReport.cleanupErrors = cleanupErrors;
    finalReport.cleanupComplete = cleanupErrors.length === 0;
    await log('IZ20_ENGINE_BRIDGE_REPORT ' + JSON.stringify(finalReport));
  }
})();
