#!/usr/bin/env python3
"""Read-only SR30C wire probe, modelled on docs/wire_captures/2026-08-26/probe.py.

stdlib only (termios). Every command below is a GET form: no CIN writes, no
settings mutation, no CLR/DCH. Usage: sr30c-probe.py <port>
"""
import os, sys, time, termios, select

RATES = [("57600", termios.B57600), ("115200", termios.B115200),
         ("38400", termios.B38400), ("19200", termios.B19200), ("9600", termios.B9600)]


def open_port(path, speed):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    cc = list(attrs[6])
    cc[termios.VMIN] = 0
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW,
                      [0, 0, termios.CS8 | termios.CREAD | termios.CLOCAL, 0, speed, speed, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def send(fd, cmd, timeout=2.0, settle=0.12):
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, (cmd + "\r").encode("ascii"))
    deadline = time.time() + timeout
    buf = b""
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                continue
            if chunk:
                buf += chunk
                if b"\r" in buf:
                    break
    time.sleep(settle)
    return buf.decode("ascii", errors="replace")


def show(cmd, resp):
    print(f"{cmd:<12} -> {resp.replace(chr(13), '<CR>')!r}", flush=True)


def main():
    port = sys.argv[1]
    print(f"# port: {port}")
    fd = None
    for name, speed in RATES:
        fd = open_port(port, speed)
        time.sleep(0.4)
        # pitfall #11: the first command after open on a CP210x can return ERR
        replies = [send(fd, "MDL") for _ in range(3)]
        print(f"# baud {name}: MDL replies {[r.replace(chr(13), '<CR>') for r in replies]}")
        if any(r.startswith("MDL,") for r in replies):
            print(f"# baud: {name}")
            break
        os.close(fd)
        fd = None
    if fd is None:
        print("NO MDL AT ANY RATE")
        return 1

    print("\n=== Phase 1: identity + live state (no program mode) ===")
    for cmd in ["MDL", "VER", "STS", "GLG", "PWR", "VOL", "SQL", "KBP", "BLT", "BSV", "CNT"]:
        show(cmd, send(fd, cmd))

    print("\n=== Phase 2: PRG bracket (GET forms only) ===")
    show("PRG", send(fd, "PRG"))
    for cmd in ["CIN,1", "CIN,2", "CIN,30", "CIN,31", "CIN,50", "CIN,51", "CIN,100",
                "CIN,200", "CIN,299", "CIN,300", "CIN,301", "CIN,400", "CIN,499",
                "CIN,500", "CIN,501", "CIN,0"]:
        show(cmd, send(fd, cmd))
    for cmd in ["SCG", "SSG", "CSG", "CSP,1", "CSP,10", "CLC", "SCO", "BPL", "PRI",
                "WXS", "KBP", "BLT", "BSV", "CNT", "VOL", "SQL", "GLF"]:
        show(cmd, send(fd, cmd))
    show("EPG", send(fd, "EPG"))
    os.close(fd)
    return 0


sys.exit(main())
