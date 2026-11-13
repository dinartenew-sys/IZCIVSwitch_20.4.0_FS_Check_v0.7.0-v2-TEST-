#!/usr/bin/env python3
"""
IZCIVSwitch CodeFS Partition Dumper
Target: Horizon OS v20.4.0 (Switch 2)

Warning: reads are sent with retarget=True. In fs-memory-control.cjs, a read whose
address falls outside the current cache plan makes the bridge write new header bytes
into FS memory before the read. This is not a read-only capture.
"""

import hashlib
import json
import os
import socket
import sys

# Configuration
CONSOLE_IP = "127.0.0.1"
PORT = 60000  # Set this to the bridge port reported by fs-check for the current run
OUTPUT_DIR = "./dumped_codefs"
CHUNK_SIZE = 0x10000  # 64 KiB chunks

def send_rpc_command(sock, command_dict):
    payload = json.dumps(command_dict) + "\n"
    sock.sendall(payload.encode('utf-8'))

    response_data = b""
    while not response_data.endswith(b"\n"):
        chunk = sock.recv(65536)
        if not chunk:
            break
        response_data += chunk

    if not response_data:
        return None
    return json.loads(response_data.decode('utf-8').strip())

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"[*] Connecting to FS Memory Bridge at {CONSOLE_IP}:{PORT}...")

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(30.0)
        s.connect((CONSOLE_IP, PORT))
    except Exception as e:
        print(f"[!] Connection failed: {e}")
        print("[*] Make sure the fs-check script is currently running and the memory bridge is active.")
        sys.exit(1)

    print("[+] Connected successfully!")

    res = send_rpc_command(s, {"command": "info"})
    if not res:
        print("[!] Failed to get info")
        s.close()
        sys.exit(1)

    print(f"[+] Bridge is ready. Storage Size: {res.get('plan', {}).get('storageSize', 'Unknown')}")

    # Both values come from the current run. The storage address changes each boot.
    STORAGE_BASE = int(input("Enter the 'storage' address from originalRom in the current fs-check report (decimal): "))
    STORAGE_SIZE = int(input("Enter the CodeFS size in bytes (required; no default): "))
    if STORAGE_BASE <= 0 or STORAGE_SIZE <= 0:
        print("[!] Address and size must both be positive.")
        s.close()
        sys.exit(1)

    out_path = os.path.join(OUTPUT_DIR, "codefs_raw.bin")
    written = 0
    error = None
    print(f"[*] Dumping {STORAGE_SIZE} bytes from {hex(STORAGE_BASE)}...")

    with open(out_path, "wb") as f:
        for offset in range(0, STORAGE_SIZE, CHUNK_SIZE):
            addr = STORAGE_BASE + offset
            length = min(CHUNK_SIZE, STORAGE_SIZE - offset)
            print(f"  - Reading 0x{addr:X} (Length: {length})")

            read_cmd = {
                "command": "read",
                "address": addr,
                "length": length,
                "retarget": True,
            }

            res = send_rpc_command(s, read_cmd)
            if not res or "outputFile" not in res:
                error = f"read failed at {hex(addr)}: {(res or {}).get('error', 'no response')}"
                break

            # The bridge saves each chunk on the PC side. Read it back and check its length.
            out_file = res["outputFile"]
            if not os.path.exists(out_file):
                error = f"bridge did not save output file: {out_file}"
                break
            with open(out_file, "rb") as chunk:
                data = chunk.read()
            os.remove(out_file)
            if len(data) != length:
                error = f"short read at {hex(addr)}: got {len(data)} of {length} bytes"
                break
            f.write(data)
            written += len(data)

    s.close()

    if error or written != STORAGE_SIZE:
        print(f"[!] Dump incomplete: {written} of {STORAGE_SIZE} bytes written. {error or ''}")
        print(f"[!] Partial file kept at {out_path}. Do not treat it as a complete CodeFS dump.")
        sys.exit(1)

    digest = hashlib.sha256()
    with open(out_path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)

    print("==================================================")
    print(f" [+] CodeFS dump complete: {written} bytes at {out_path}")
    print(f" [+] sha256 {digest.hexdigest()}")
    print("==================================================")

if __name__ == "__main__":
    main()
