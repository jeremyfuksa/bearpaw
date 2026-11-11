#!/usr/bin/env python3
"""SR30C BLT probe (#847, #848). WRITES ONE SETTING: the backlight level.

Context: Uniden's software set the level to Low and wrote it to the radio, and
`BLT` changed from `BLT,,,10` (High) to `BLT,,,5` (Low). This checks whether
Bearpaw can set it: write each level in both modes, read back, and finish on
High, the level the radio had before the experiment. Never touches channel memory.

stdlib only. Usage: sr30c-blt-probe.py <port>
"""
import os, sys, time, termios, select


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


def send(fd, cmd, timeout=2.0):
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
    time.sleep(0.12)
    resp = buf.decode("ascii", errors="replace").strip("\r\x00")
    print(f"{cmd:<14} -> {resp!r}", flush=True)
    return resp


def main():
    fd = open_port(sys.argv[1])
    time.sleep(0.4)
    mdl = ""
    for _ in range(3):
        mdl = send(fd, "MDL")
        if mdl.startswith("MDL,"):
            break
    if mdl != "MDL,SR30C":
        print(f"REFUSING: expected MDL,SR30C, got {mdl!r}")
        return 1
    start = send(fd, "BLT")
    if not start.startswith("BLT,"):
        print("REFUSING: BLT unreadable")
        return 1

    print("\n=== Outside program mode ===")
    for w in ["BLT,,,10", "BLT,,,5", "BLT,,,7"]:
        send(fd, w)
        send(fd, "BLT")
    print("\n=== Inside program mode ===")
    send(fd, "PRG")
    for w in ["BLT,,,10", "BLT,,,5"]:
        send(fd, w)
        send(fd, "BLT")
    send(fd, "EPG")

    # The radio was High (`BLT,,,10`) before Uniden's software wrote Low for
    # the experiment, so High is the level to leave it on.
    print("\n=== Restore to High ===")
    send(fd, "BLT,,,10")
    final = send(fd, "BLT")
    print("RESTORED" if final == "BLT,,,10" else f"RESTORE FAILED: {final!r}")
    os.close(fd)
    return 0


sys.exit(main())
