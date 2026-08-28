#!/usr/bin/env python3
"""BC75XLT custom-search probe: CSG and CSP, read -> write -> read back -> restore.

stdlib only (termios). Settles the two open questions behind the Device tab's
Custom Search page on this model:

  1. `CSG` shape. The BC75XLT spec is `CSG,##########,[DLY],[DIR]`; the BC125AT
     is a bare mask, and that is what Bearpaw sends today. A format error
     aborts the whole set command, so "it probably works" is not good enough.
  2. `CSP` writes. Never probed on this model -- `export_bc75xlt_ss_file`
     deliberately refuses to send it (an unanswered command inside the PRG
     bracket is the #436 failure), while the settings snapshot and
     `set_custom_range` send it anyway. Those two positions contradict.

THIS SCRIPT WRITES. It reads every value first, prints it, restores at the end,
and verifies the restore. Nothing is invented: the only frequencies written are
ones already stored in another range slot on this same radio, so they are
legal under whatever band plan is active. Run it with the scanner idle.

Usage:
    python3 custom-search-probe.py [/dev/cu.xxx] | tee custom-search-probe.txt
"""
import glob
import os
import select
import sys
import termios
import time

# One scanner presents up to four nodes (two drivers x cu./tty.). Never probe a
# tty.* node -- it blocks on carrier detect, which a scanner never asserts.
PORT_GLOBS = ["/dev/cu.usbserial-*", "/dev/cu.SLAB_USBtoUART*"]


def find_port():
    if len(sys.argv) > 1:
        return sys.argv[1]
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
    """One command, one response. The wire is \\r-terminated and not pipelined."""
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
    return buf.decode("ascii", errors="replace").strip("\r\n")


def show(fd, cmd, **kw):
    resp = send(fd, cmd, **kw)
    print(f"{cmd:<34} -> {resp!r}")
    return resp


def fields(resp, cmd_name):
    """Response payload as a list, with the echoed command name dropped."""
    parts = [p.strip() for p in resp.split(",")]
    if parts and parts[0].upper() == cmd_name.upper():
        parts = parts[1:]
    return parts


def main():
    port = find_port()
    if not port or not os.path.exists(port):
        print(f"NO PORT (looked for {' '.join(PORT_GLOBS)})")
        return 1
    print(f"# port: {port}  baud: 57600")
    try:
        fd = open_port(port)
    except Exception as exc:
        print(f"OPEN FAILED: {exc}")
        return 1
    time.sleep(0.4)

    print("\n=== Phase 0: identity ===")
    # The first command after a fresh open can return ERR -- a CP210x bridge
    # buffers whatever was on the line. Retry once.
    model = show(fd, "MDL")
    if "BC75XLT" not in model:
        model = show(fd, "MDL")
    if "BC75XLT" not in model:
        print(f"ABORT: expected a BC75XLT, got {model!r}. This probe writes; refusing.")
        os.close(fd)
        return 1
    show(fd, "VER")

    print("\n=== Phase 1: is CSG program-mode only? ===")
    show(fd, "CSG")  # expect NG outside PRG

    print("\n=== Phase 2: read everything first (restore depends on this) ===")
    if "OK" not in show(fd, "PRG"):
        print("ABORT: could not enter program mode.")
        os.close(fd)
        return 1
    try:
        csg_raw = show(fd, "CSG")
        csg = fields(csg_raw, "CSG")
        originals = {}
        for idx in range(1, 11):
            resp = show(fd, f"CSP,{idx}")
            parts = fields(resp, "CSP")
            if parts and parts[0] == str(idx):
                parts = parts[1:]
            originals[idx] = [p for p in parts if p != ""]

        print("\n--- parsed ---")
        print(f"CSG fields: {csg}   (1 field = BC125AT shape, 3 = BC75XLT spec shape)")
        for idx, vals in originals.items():
            print(f"CSP,{idx:<2} -> {vals}")

        print("\n=== Phase 3: CSG write shape ===")
        # Writing the mask back unchanged. Both forms are tried; whichever
        # answers OK is the shape Bearpaw must send on this model.
        mask = csg[0] if csg else None
        if not mask or set(mask) - {"0", "1"} or len(mask) != 10:
            print(f"SKIP: CSG mask unreadable ({csg!r}), not risking a write.")
        else:
            show(fd, f"CSG,{mask}")
            if len(csg) >= 3:
                show(fd, f"CSG,{mask},{csg[1]},{csg[2]}")
            show(fd, "CSG")  # confirm unchanged either way

        print("\n=== Phase 4: CSP write + read back ===")
        # Nothing invented: range 10 is written the values range 9 already
        # holds, so they are legal under whatever band plan is active. Then
        # range 10's own values go back.
        src, dst = originals.get(9), originals.get(10)
        if not (src and dst and len(src) >= 2 and len(dst) >= 2):
            print(f"SKIP: need two readable ranges, got 9={src!r} 10={dst!r}.")
        elif src[:2] == dst[:2]:
            print("SKIP: ranges 9 and 10 hold identical limits; a read back would prove nothing.")
        else:
            show(fd, f"CSP,10,{src[0]},{src[1]}")
            back = fields(show(fd, "CSP,10"), "CSP")
            if back and back[0] == "10":
                back = back[1:]
            back = [p for p in back if p != ""]
            print(f"--- write {src[:2]} -> read back {back[:2]} : "
                  f"{'MATCH' if back[:2] == src[:2] else 'MISMATCH'}")

            print("\n=== Phase 5: restore ===")
            show(fd, f"CSP,10,{dst[0]},{dst[1]}")
            final = fields(show(fd, "CSP,10"), "CSP")
            if final and final[0] == "10":
                final = final[1:]
            final = [p for p in final if p != ""]
            if final[:2] == dst[:2]:
                # States the end state, not the action: when the radio refuses
                # the write outright, nothing moved and this still holds.
                print(f"--- CSP,10 holds its original limits: {dst[:2]}")
            else:
                print(f"!!! RESTORE FAILED. CSP,10 is {final[:2]}, was {dst[:2]}.")
                print("!!! Set it back from the scanner's own Custom Search menu.")
    finally:
        show(fd, "EPG")
        os.close(fd)
    return 0


sys.exit(main())
