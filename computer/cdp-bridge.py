#!/usr/bin/env python3
"""The computer's browser for noid's server: its DevTools socket on stdin and stdout.

The browser is an ordinary Chromium on the desktop (noid-browser starts it when it is not running), listening for
DevTools on a local port, as rakazo's is. noid's server reaches it over `docker exec -i`, which carries a pipe, not a
socket: this joins the two. On stdin and stdout it speaks Chromium's pipe protocol (JSON, each message ended by a NUL
byte); to the browser, a WebSocket. Leaving (stdin closed) leaves the browser running for the people using it.
Standard library only, as rakazo's rakazo-page-browser.
"""

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request

PORT = int(os.environ.get("NOID_BROWSER_PORT", "9222"))


def version():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2) as answer:
            return json.load(answer)
    except Exception:  # noqa: BLE001
        return None


def browser():
    found = version()

    if found is None:
        # Started in a session of its own, so it outlives this bridge.
        subprocess.Popen(
            ["noid-browser"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        deadline = time.time() + 30

        while found is None and time.time() < deadline:
            time.sleep(0.25)
            found = version()

    if found is None:
        sys.stderr.write("The computer's browser did not start.\n")
        sys.exit(1)

    return found["webSocketDebuggerUrl"]


def connect(url):
    path = url.split(f":{PORT}", 1)[1]
    sock = socket.create_connection(("127.0.0.1", PORT))
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        (
            f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    head = b""

    while b"\r\n\r\n" not in head:
        part = sock.recv(1)

        if not part:
            sys.exit(1)

        head += part

    if b" 101 " not in head.split(b"\r\n", 1)[0]:
        sys.stderr.write("The browser refused the connection.\n")
        sys.exit(1)

    return sock


def main():
    sock = connect(browser())
    sending = threading.Lock()
    out = sys.stdout.buffer

    def send(opcode, data):
        mask = os.urandom(4)
        size = len(data)

        if size < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | size)
        elif size < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, size)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, size)

        # A client's frames are masked: XOR with the key, done on one big integer rather than byte by byte.
        key = int.from_bytes((mask * (size // 4 + 1))[:size], "big")
        masked = (int.from_bytes(data, "big") ^ key).to_bytes(size, "big") if size else b""

        with sending:
            sock.sendall(head + mask + masked)

    def from_browser():
        reader = sock.makefile("rb", buffering=1 << 20)

        def need(count):
            data = reader.read(count)

            if len(data) < count:
                os._exit(0)

            return data

        while True:
            first, second = need(2)
            opcode = first & 0x0F
            size = second & 0x7F

            if size == 126:
                size = struct.unpack("!H", need(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", need(8))[0]

            payload = need(size)

            if opcode == 0x8:
                os._exit(0)
            elif opcode == 0x9:
                send(0xA, payload)
            elif opcode in (0x0, 0x1, 0x2):
                # A message in pieces is written as it comes; its NUL follows the last piece.
                out.write(payload)

                if first & 0x80:
                    out.write(b"\0")
                    out.flush()

    threading.Thread(target=from_browser, daemon=True).start()

    stdin = sys.stdin.buffer
    pending = b""

    while True:
        chunk = stdin.read1(1 << 16)

        if not chunk:
            break

        pending += chunk

        while b"\0" in pending:
            message, pending = pending.split(b"\0", 1)
            send(0x1, message)

    try:
        send(0x8, b"")
    except OSError:
        pass


if __name__ == "__main__":
    main()
