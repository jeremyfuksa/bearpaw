#!/usr/bin/env python3
"""Read-only BC75XLT wire probe. stdlib only (termios). No writes to scanner memory."""
import os, sys, time, termios, select

PORT = "/dev/cu.usbserial-020D43D8"

def open_port(path):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
    # raw 8N1, no flow control, local mode, receiver on
    iflag = 0
    oflag = 0
    lflag = 0
    cflag = termios.CS8 | termios.CREAD | termios.CLOCAL
    ispeed = ospeed = termios.B57600
    cc = list(cc)
    cc[termios.VMIN] = 0
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, ispeed, ospeed, cc])
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
    print(f"{cmd:<12} -> {resp.replace(chr(13), '<CR>')!r}")

def main():
    if not os.path.exists(PORT):
        print(f"NO PORT: {PORT}")
        return 1
    try:
        fd = open_port(PORT)
    except Exception as e:
        print(f"OPEN FAILED: {e}")
        return 1
    time.sleep(0.4)

    print("=== Phase 1: identity + live state (no program mode) ===")
    for cmd in ["MDL", "VER", "STS", "GLG", "PWR", "VOL", "SQL"]:
        show(cmd, send(fd, cmd))

    print("\n=== Phase 2: PRG bracket (read-only) ===")
    show("PRG", send(fd, "PRG"))
    for cmd in ["CIN,1", "CIN,2", "CIN,30", "CIN,31", "CIN,299",
                "CIN,300", "CIN,301", "CIN,500", "SCG", "BLT", "PRI"]:
        show(cmd, send(fd, cmd))
    show("EPG", send(fd, "EPG"))
    os.close(fd)
    return 0

sys.exit(main())
