#!/usr/bin/env python3
"""BC75XLT SSP write probe: read all 10 -> write one -> read back -> restore.

Companion to ssp-bpl-probe.py, which established that `SSP` is program-mode
only, takes an index 1-10, and reads back as `SSP,<index>,<delay>,<direction>`
(all ten currently `1,0`). This settles the remaining half of #478's SSP item:
whether the two fields can be WRITTEN, and which is which.

Only index 1 is touched. Every one of the ten is read first so the restore is
never blind, and the restore is verified before the script exits.

Usage:
    python3 ssp-write-probe.py [/dev/cu.xxx] | tee ssp-write-probe.txt
"""
import glob
import os
import select
import sys
import termios
import time

PORT_GLOBS = ["/dev/cu.usbserial-*", "/dev/cu.SLAB_USBtoUART*"]
TARGET = 1  # only this service index is written


def find_port():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        return args[0]
    for pattern in PORT_GLOBS:
        found = sorted(glob.glob(pattern))
        if found:
            return found[0]
    return None


def open_port(path):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    iflag, oflag, cflag, lflag, ispeed, ospeed, cc = termios.tcgetattr(fd)
    iflag = oflag = lflag = 0
    cflag = termios.CS8 | termios.CREAD | termios.CLOCAL
    ispeed = ospeed = termios.B57600
    cc = list(cc)
    cc[termios.VMIN] = 0
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, ispeed, ospeed, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def send(fd, cmd, timeout=2.0, settle=0.12):
    try:
        termios.tcflush(fd, termios.TCIFLUSH)
    except termios.error:
        pass
    os.write(fd, (cmd + "\r").encode("ascii"))
    deadline = time.time() + timeout
    buf = b""
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except (BlockingIOError, OSError):
                continue
            if chunk:
                buf += chunk
                if b"\r" in buf:
                    break
    time.sleep(settle)
    return buf.decode("ascii", errors="replace").strip("\r\n")


def show(fd, cmd, **kw):
    resp = send(fd, cmd, **kw)
    print(f"{cmd:<34} -> {resp!r}")
    return resp


def main():
    port = find_port()
    if not port or not os.path.exists(port):
        print(f"NO PORT (looked for {' '.join(PORT_GLOBS)})")
        return 1
    print(f"# port: {port}  baud: 57600")
    fd = open_port(port)
    time.sleep(0.4)
    try:
        print("=== Phase 0: identity ===")
        model = show(fd, "MDL")
        if "BC75XLT" not in model:
            model = show(fd, "MDL")
        if "BC75XLT" not in model:
            print(f"ABORT: expected a BC75XLT, got {model!r}. This probe writes; refusing.")
            return 1

        if "OK" not in show(fd, "PRG"):
            print("ABORT: could not enter program mode.")
            return 1

        rc = 0
        try:
            print("\n=== Phase 1: read all ten first (restore depends on this) ===")
            originals = {}
            for idx in range(1, 11):
                resp = show(fd, f"SSP,{idx}")
                originals[idx] = resp

            orig = originals[TARGET]
            parts = [p.strip() for p in orig.split(",")]
            # SSP,<index>,<delay>,<direction>
            if len(parts) < 4:
                print(f"ABORT: unexpected SSP shape {orig!r}; restore would be blind.")
                return 1
            o_delay, o_dir = parts[2], parts[3]
            print(f"\n--- SSP,{TARGET} currently delay={o_delay!r} direction={o_dir!r} ---")

            print("\n=== Phase 2: write field 1 (presumed delay) ===")
            new_delay = "0" if o_delay != "0" else "1"
            w1 = show(fd, f"SSP,{TARGET},{new_delay},{o_dir}")
            r1 = show(fd, f"SSP,{TARGET}")
            p1 = [p.strip() for p in r1.split(",")]
            if "OK" in w1 and len(p1) >= 4:
                print(f"wrote delay={new_delay!r} -> read back {p1[2]!r} "
                      f"({'PERSISTED' if p1[2] == new_delay else 'DID NOT PERSIST'})")
            else:
                print(f"write refused or unreadable: {w1!r} / {r1!r}")

            print("\n=== Phase 3: write field 2 (presumed direction) ===")
            new_dir = "1" if o_dir != "1" else "0"
            w2 = show(fd, f"SSP,{TARGET},{new_delay},{new_dir}")
            r2 = show(fd, f"SSP,{TARGET}")
            p2 = [p.strip() for p in r2.split(",")]
            if "OK" in w2 and len(p2) >= 4:
                print(f"wrote direction={new_dir!r} -> read back {p2[3]!r} "
                      f"({'PERSISTED' if p2[3] == new_dir else 'DID NOT PERSIST'})")
            else:
                print(f"write refused or unreadable: {w2!r} / {r2!r}")

            print("\n=== Phase 4: does a write to one index touch the others? ===")
            drift = 0
            for idx in range(1, 11):
                if idx == TARGET:
                    continue
                now = show(fd, f"SSP,{idx}")
                if now != originals[idx]:
                    drift += 1
                    print(f"  *** SSP,{idx} CHANGED: {originals[idx]!r} -> {now!r}")
            print(f"\n{'No drift in the other nine.' if drift == 0 else f'*** {drift} other index/indices changed ***'}")
            if drift:
                rc = 1

            print(f"\n=== Phase 5: restore SSP,{TARGET} to delay={o_delay!r} direction={o_dir!r} ===")
            show(fd, f"SSP,{TARGET},{o_delay},{o_dir}")
            final = show(fd, f"SSP,{TARGET}")
            if final == orig:
                print(f"RESTORED exactly: {final!r}")
            else:
                rc = 1
                print(f"*** RESTORE FAILED: {final!r}, expected {orig!r} ***")
        finally:
            print("\n=== Phase 6: leaving program mode ===")
            show(fd, "EPG")
        return rc
    finally:
        os.close(fd)


if __name__ == "__main__":
    sys.exit(main())
