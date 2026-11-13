// SPDX-License-Identifier: GPL-2.0-only
// Uses the existing CivSwitch loader's lexical primitives; do not install as core.js.
(async function () {
  'use strict';
  const reference = __REFERENCE_PROFILE__;
  const marker = 'IZ20_REPORT ';
  const report = {
    schemaVersion: 1,
    tool: 'izcivswitch-sdk-check',
    upstreamCommit: reference.upstream.commit,
    requestedFirmware: reference.requestedFirmware,
    firmwareEvidence: reference.firmwareEvidence,
    status: 'ERROR',
    applicationSdkMatch: false,
    systemFilesystemSupport: 'UNTESTED',
    workerExecution: 'NOT_ATTEMPTED',
    filesystemAcquisition: 'NOT_ATTEMPTED',
    saveChanges: 'NOT_ATTEMPTED',
    signatureCount: reference.signatures.length,
    signatureMatches: 0,
    mismatchCount: 0,
    mismatches: []
  };
  let allocation = 0n;
  const hex = value => '0x' + BigInt(value).toString(16);
  function stop(status, message) {
    report.status = status;
    throw new Error(message);
  }
  // read64 in the supplied loader reads eight bytes even for a one-byte request.
  // Align each primitive read and keep its entire width inside the checked span.
  function readHex(address, length) {
    let output = '', cachedAddress = -1n, cached = 0n;
    for (let i = 0; i < length; i++) {
      const current = address + BigInt(i), aligned = current & ~7n;
      if (aligned !== cachedAddress) {
        cached = read64(aligned);
        cachedAddress = aligned;
      }
      const byte = Number((cached >> ((current - aligned) * 8n)) & 255n);
      output += byte.toString(16).padStart(2, '0');
    }
    return output;
  }
  function inside(address, length, base, size) {
    const first = address & ~7n;
    const last = (address + BigInt(length) + 7n) & ~7n;
    return length > 0 && first >= base && last <= base + size;
  }
  async function sdkCrc32(base, size) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      table[i] = value >>> 0;
    }
    let crc = 0xffffffff;
    for (let offset = 0; offset < size; offset += 8) {
      const word = read64(base + BigInt(offset));
      let low = Number(word & 0xffffffffn), high = Number(word >> 32n);
      for (let byte = 0; byte < 4; byte++) {
        crc = (crc >>> 8) ^ table[(crc ^ low) & 255];
        low >>>= 8;
      }
      for (let byte = 0; byte < 4; byte++) {
        crc = (crc >>> 8) ^ table[(crc ^ high) & 255];
        high >>>= 8;
      }
      if ((offset + 8) % 0x80000 === 0)
        await log('SDK checksum: ' + (offset + 8) + '/' + size + ' bytes');
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  try {
    if (typeof read64 !== 'function' || typeof read32 !== 'function' ||
        typeof call_rop !== 'function' || typeof malloc !== 'function' ||
        typeof free !== 'function' || typeof sdk_base !== 'bigint')
      stop('LOADER_INTERFACE_MISMATCH', 'Required CivSwitch primitives are unavailable.');
    if (sdk_base <= 0n || sdk_base >= (1n << 39n) || (sdk_base & 7n) !== 0n)
      stop('LOADER_INTERFACE_MISMATCH', 'The SDK anchor is not a valid aligned address.');
    report.sdkAnchor = hex(sdk_base);
    await log('Checking the existing Civ7 SDK (preflight only).');
    const sdkSpec = reference.sdk;
    const queryAddress = sdk_base + BigInt(sdkSpec.queryMemoryOffset);
    // Bootstrap assumption: this core.js derives sdk_base from its embedded memcpy.
    // Only the known QueryMemory wrapper is inspected before a mapping is available.
    // There is deliberately no search through unknown or unmapped memory.
    if (readHex(queryAddress, sdkSpec.queryMemoryBytes.length / 2) !== sdkSpec.queryMemoryBytes)
      stop('QUERY_WRAPPER_MISMATCH', 'The known QueryMemory wrapper differs; stopped before native calls.');
    allocation = malloc(0x80);
    if (typeof allocation !== 'bigint' || allocation <= 0n || allocation >= (1n << 39n)) {
      allocation = 0n;
      stop('ALLOCATION_FAILED', 'Could not allocate the small mapping-query output buffer.');
    }
    const queryResult = call_rop(queryAddress, allocation, allocation + 0x40n, sdk_base);
    report.queryResult = hex(queryResult);
    if (queryResult !== 0n)
      stop('QUERY_FAILED', 'QueryMemory did not succeed.');
    const base = read64(allocation), size = read64(allocation + 8n);
    const type = Number(read32(allocation + 0x10n));
    const attributes = Number(read32(allocation + 0x14n));
    const permissions = Number(read32(allocation + 0x18n));
    report.sdkMapping = {base: hex(base), bytes: Number(size), type, attributes, permissions};
    if (size !== BigInt(sdkSpec.textBytes) || type !== sdkSpec.mappingType ||
        attributes !== sdkSpec.attributes || permissions !== sdkSpec.permissions ||
        base <= 0n || base + size >= (1n << 39n) || (base & 0xfffn) !== 0n ||
        sdk_base < base || sdk_base >= base + size)
      stop('SDK_MAPPING_MISMATCH', 'The SDK code mapping differs from the upstream application profile.');
    for (const signature of reference.signatures) {
      const address = base + BigInt(signature.offset), length = signature.bytes.length / 2;
      if (!inside(address, length, base, size))
        stop('REFERENCE_RANGE_ERROR', 'A signature would leave the verified SDK code mapping.');
      const actual = readHex(address, length);
      if (actual === signature.bytes) report.signatureMatches++;
      else {
        report.mismatchCount++;
        if (report.mismatches.length < 10)
          report.mismatches.push({name: signature.name, offset: hex(signature.offset),
            expectedPrefix: signature.bytes.slice(0, 32), actualPrefix: actual.slice(0, 32)});
      }
    }
    if (report.mismatchCount)
      stop('SDK_SIGNATURE_MISMATCH', 'Application instruction signatures differ; no worker or FS calls were made.');
    await log('All ' + report.signatureMatches + ' signatures match. Checking the complete SDK code checksum.');
    // Compute in JS; do not execute an unverified native checksum implementation.
    report.sdkCrc32 = await sdkCrc32(base, sdkSpec.textBytes);
    report.expectedSdkCrc32 = sdkSpec.crc32;
    if (report.sdkCrc32 !== sdkSpec.crc32)
      stop('SDK_CHECKSUM_MISMATCH', 'SDK instruction prefixes match, but the complete code checksum differs.');
    report.applicationSdkMatch = true;
    report.status = 'SDK_FINGERPRINT_MATCH';
    report.message = 'The application SDK matches the upstream profile. System FS compatibility remains untested.';
  } catch (error) {
    report.message = String(error && error.message || error);
    report.applicationSdkMatch = false;
  } finally {
    if (allocation !== 0n) {
      try { free(allocation); report.queryBufferReleased = true; }
      catch (error) {
        report.queryBufferReleased = false;
        report.cleanupError = String(error && error.message || error);
        report.applicationSdkMatch = false;
        report.status = 'CLEANUP_ERROR';
      }
    }
  }
  await log(marker + JSON.stringify(report));
  return report;
})()
