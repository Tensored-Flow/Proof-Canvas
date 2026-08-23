"""Fail unless every task-owned TCP port can be rebound after process cleanup."""

import math
import os
import socket
import sys
import time


ports = [int(value) for value in sys.argv[1:]]
if not ports:
    raise SystemExit("at least one port is required")

try:
    timeout_seconds = float(os.environ.get("PROOFCANVAS_PORT_RELEASE_TIMEOUT_SECONDS", "10"))
except ValueError as error:
    raise SystemExit("PROOFCANVAS_PORT_RELEASE_TIMEOUT_SECONDS must be numeric") from error
if not math.isfinite(timeout_seconds) or not 0.05 <= timeout_seconds <= 30:
    raise SystemExit("PROOFCANVAS_PORT_RELEASE_TIMEOUT_SECONDS must be between 0.05 and 30")

deadline = time.monotonic() + timeout_seconds
pending = set(ports)
while pending and time.monotonic() < deadline:
    for port in tuple(pending):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            pending.remove(port)
    if pending:
        time.sleep(0.1)

if pending:
    raise SystemExit(f"task-owned ports remain bound after cleanup: {sorted(pending)}")
print(f"task-owned ports released: {ports}")
