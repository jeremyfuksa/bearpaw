#!/usr/bin/env python3
"""SR30C settings write probe (#846, the non-CIN rows). WRITES SETTINGS.

For each setting: read it, write a test value, read it back, then write the
ORIGINAL read reply back verbatim (a read reply is also a valid write command)
and read again to confirm the restore. Write shapes are the ones Bearpaw sends
(settings.rs, banks.rs, commands.rs, import_ss.rs) plus an echo of the radio's
own reply. Never sends CLR, DCH, or any CIN write.

stdlib only. Usage: sr30c-settings-probe.py <port>
"""
import os, sys, time, termios, select

# (read command, [test writes]). Restore is always the original read reply.
OUTSIDE_PRG = [
    ("VOL", ["VOL,5"]),
    ("SQL", ["SQL,4"]),
]
INSIDE_PRG = [
    ("SCG", ["SCG,0000000000", "SCG,1111111111"]),  # all-disabled should be refused
    ("BPL", ["BPL,1"]),
    ("PRI", ["PRI,1", "PRI,2"]),
    ("KBP", ["KBP,,1", "KBP,1,0"]),  # lock on; then a value in the beep field
    # echo of its own 3-field reply; Bearpaw's 2-field form; changed values in the 3-field form
    ("SCO", ["<echo>", "SCO,2,1", "SCO,0,,0", "SCO,1,,1", "SCO,2,,0"]),
    ("CLC", ["CLC,2,0,0,11111,", "CLC,3,0,0,11101,", "CLC,2,0,0,11101,1"]),
    ("CSG", ["<echo>", "CSG,1000000000,1,0"]),
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
    if mdl != "MDL,SR30C":
        print(f"REFUSING: expected MDL,SR30C, got {mdl!r}")
        return 1
    send(fd, "VER")
    failures = []

    print("\n=== Outside program mode ===")
    for read_cmd, writes in OUTSIDE_PRG:
        probe(fd, read_cmd, writes, failures)

    print("\n=== Inside program mode ===")
    if send(fd, "PRG") != "PRG,OK":
        print("REFUSING: PRG not OK")
        return 1
    try:
        for read_cmd, writes in INSIDE_PRG:
            probe(fd, read_cmd, writes, failures)
    finally:
        send(fd, "EPG")
        os.close(fd)
    print("\nALL RESTORED" if not failures else f"\nCHECK BY HAND: {failures}")
    return 0


sys.exit(main())
