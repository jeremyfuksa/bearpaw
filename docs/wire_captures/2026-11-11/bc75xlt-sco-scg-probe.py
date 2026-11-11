#!/usr/bin/env python3
"""BC75XLT SCO / SCG write probe. WRITES SETTINGS, restores each one.

Settles two claims from public code that contradict Bearpaw:

1. SCO. Bearpaw sets has_search_options = false on the BC75XLT because every
   write was refused (#638, hardware 2026-09-02). Every write tried then was
   the BC125AT's 2-field shape, SCO,<delay>,<code>. The radio itself reports
   a 3-field shape (SCO,1,,0, bc75xlt-probe.txt), which is what the SR30C
   accepts (sr30c-findings.md). fruzyna/bearcat's hardware test writes
   SCO,<0|1>,,<dir> to a BC75XLT and asserts the read-back
   (tests/test_bc75xlt.py:103-108). Untested here until now.
2. SCG. The SR30C stores an all-disabled mask (SCG,1111111111). The same
   fruzyna test says "one group will always be true" on a BC75XLT, i.e. the
   firmware may refuse or rewrite an all-disabled mask.

For each setting: read, write a test value, read back, restore the original
read reply verbatim (a read reply is also a valid write), read again. The
SCO and SCG reads outside program mode come first, to record whether they
answer NG there as on the SR30C. Never sends CLR, DCH, WIN or any CIN write.

Template: 2026-11-10/sr30c-settings-probe.py.
stdlib only. Usage: bc75xlt-sco-scg-probe.py <port>
"""
import os, sys, time, termios, select

OUTSIDE_PRG_READS = ["SCO", "SCG"]

# (read command, [test writes]). Restore is always the original read reply.
INSIDE_PRG = [
    ("SCO", [
        "SCO,1,0",   # the 2-field shape refused in #638: reproduce the ERR
        "<echo>",    # its own 3-field reply, written back unchanged
        "SCO,0,,0",  # delay off, 3-field
        "SCO,1,,1",  # delay on, direction changed
        "SCO,2,,0",  # delay 2: the SR30C OKs it and does not apply it
    ]),
    ("SCG", [
        "SCG,1111111110",  # control: one bank enabled
        "SCG,1111111111",  # all disabled: refused, rewritten, or stored?
    ]),
]


def open_port(path):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    cc = list(termios.tcgetattr(fd)[6])
    cc[termios.VMIN] = 0
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW,
                      [0, 0, termios.CS8 | termios.CREAD | termios.CLOCAL, 0,
                       termios.B57600, termios.B57600, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def send(fd, cmd, timeout=2.0, settle=0.12):
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, (cmd + "\r").encode("ascii"))
    deadline, buf = time.time() + timeout, b""
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                buf += os.read(fd, 4096)
            except BlockingIOError:
                continue
            if b"\r" in buf:
                break
    time.sleep(settle)
    resp = buf.decode("ascii", errors="replace").strip("\r\x00")
    print(f"{cmd:<28} -> {resp!r}", flush=True)
    return resp


def probe(fd, read_cmd, writes, failures):
    print(f"\n--- {read_cmd}")
    before = send(fd, read_cmd)
    if not before.startswith(read_cmd + ","):
        print(f"    SKIP: unreadable ({before!r})")
        failures.append(read_cmd)
        return
    for w in writes:
        w = before if w == "<echo>" else w
        reply = send(fd, w)
        after = send(fd, read_cmd)
        verdict = ("stored as sent" if after == w
                   else "unchanged" if after == before
                   else "stored differently")
        print(f"    {w!r}: reply {reply!r}, now {after!r} -> {verdict}")
        if after != before:
            send(fd, before)
    final = send(fd, read_cmd)
    ok = final == before
    print(f"    restore: {'OK' if ok else f'FAILED, {final!r} vs {before!r}'}")
    if not ok:
        failures.append(read_cmd)


def main():
    fd = open_port(sys.argv[1])
    time.sleep(0.4)
    mdl = ""
    for _ in range(3):  # pitfall #11: first command after open can be garbled
        mdl = send(fd, "MDL")
        if mdl.startswith("MDL,"):
            break
    if mdl != "MDL,BC75XLT":
        print(f"REFUSING: expected MDL,BC75XLT, got {mdl!r}")
        return 1
    send(fd, "VER")
    failures = []

    print("\n=== Outside program mode (reads only) ===")
    for cmd in OUTSIDE_PRG_READS:
        send(fd, cmd)

    print("\n=== Inside program mode ===")
    if send(fd, "PRG") != "PRG,OK":
        print("REFUSING: PRG not OK")
        return 1
    try:
        for read_cmd, writes in INSIDE_PRG:
            probe(fd, read_cmd, writes, failures)
    finally:
        send(fd, "EPG")

    # A value can read back inside PRG and still be lost at EPG. Open a fresh
    # bracket and read both again (they may answer NG outside PRG), so the
    # capture shows what the radio kept across the restore.
    print("\n=== Fresh bracket after EPG (reads only) ===")
    if send(fd, "PRG") == "PRG,OK":
        try:
            for read_cmd, _ in INSIDE_PRG:
                send(fd, read_cmd)
        finally:
            send(fd, "EPG")
    os.close(fd)
    print("\nALL RESTORED" if not failures else f"\nCHECK BY HAND: {failures}")
    return 0


sys.exit(main())
