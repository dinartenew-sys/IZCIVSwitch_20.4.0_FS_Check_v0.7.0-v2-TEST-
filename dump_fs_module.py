#!/usr/bin/env python3
"""
IZCIVSwitch Live Memory Module Dumper
Target: Horizon OS v20.4.0 (Switch 2)
"""

import hashlib
import json
import os
import socket
import sys

# Configuration
CONSOLE_IP = "127.0.0.1"
PORT = 0  # Will be requested at runtime
OUTPUT_DIR = "./dumped_modules"
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
    global PORT
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Ask the user for the port here
    port_input = input("Enter the socket port from the memory-ready log (e.g., 54321): ").strip()
    if not port_input.isdigit():
        print("[!] Invalid port. Please enter a number.")
        sys.exit(1)
    PORT = int(port_input)

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

    print(f"[+] Bridge is ready. Current Plan Target: {hex(res.get('plan', {}).get('target', 0))}")

    # Get the target address and size from the user
    print("\n--- Module Dump Configuration ---")
    print("Find the 'fs' module base address and size from your memory-map.json or logs.")
    try:
        MODULE_BASE = int(input("Enter the module base address (hex or decimal, e.g. 0x12345678): "), 0)
        MODULE_SIZE = int(input("Enter the module size in bytes (e.g. 0x300000): "), 0)
        MODULE_NAME = input("Enter a name for the output file (e.g. fs_module): ").strip()
    except ValueError:
        print("[!] Invalid input. Please enter numbers.")
        s.close()
        sys.exit(1)

    if not MODULE_NAME:
        MODULE_NAME = "module"

    if MODULE_BASE <= 0 or MODULE_SIZE <= 0:
        print("[!] Address and size must both be positive.")
        s.close()
        sys.exit(1)

    out_path = os.path.join(OUTPUT_DIR, f"{MODULE_NAME}.bin")
    written = 0
    error = None
    print(f"\n[*] Dumping {MODULE_SIZE} bytes from {hex(MODULE_BASE)}...")

    with open(out_path, "wb") as f:
        for offset in range(0, MODULE_SIZE, CHUNK_SIZE):
            addr = MODULE_BASE + offset
            length = min(CHUNK_SIZE, MODULE_SIZE - offset)
            
            # Print progress every 16 chunks (1MB) to avoid console spam
            if offset % (CHUNK_SIZE * 16) == 0:
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

    if error or written != MODULE_SIZE:
        print(f"\n[!] Dump incomplete: {written} of {MODULE_SIZE} bytes written. {error or ''}")
        print(f"[!] Partial file kept at {out_path}. Do not treat it as a complete dump.")
        sys.exit(1)

    digest = hashlib.sha256()
    with open(out_path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)

    print("==================================================")
    print(f" [+] Dump complete: {written} bytes at {out_path}")
    print(f" [+] sha256 {digest.hexdigest()}")
    print("==================================================")

if __name__ == "__main__":
    main()