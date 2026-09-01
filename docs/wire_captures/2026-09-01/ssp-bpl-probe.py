#!/usr/bin/env python3
"""BC75XLT SSP + BPL probe: read -> write -> read back -> restore -> verify.

Closes the two items #478 still lists as unprobed on this model.

  1. `SSP` -- per-service delay and direction. Not implemented anywhere in
     Bearpaw. It is the only service-search control this model has (there is
     no `SSG`, which is why the subtab is hidden as of #469). Shape unknown:
     index range, field count, and whether it is program-mode only.

  2. `BPL` writes -- the band plan reads fine (`BPL,0`) and has never been
     written. This is where modulation lives on this model, and the spec warns
     "Band Plan setting affects frequency step. Issue this command before
     frequency programming" -- so a write has consequences beyond itself.

THIS SCRIPT WRITES. Safety, in order of how much it matters:

  * It refuses to run against anything but a BC75XLT.
  * It reads every value before touching it, and restores at the end.
  * The BPL write is staged: the CURRENT value is written back first (a no-op
    that still exercises the write path), and only if that is accepted does it
    try the other value.
  * It NEVER programs a frequency while the band plan is changed -- that is
    the exact hazard the spec names.
  * It samples channel memory before and after the BPL round trip and diffs
    them, so a band-plan write that disturbed stored channels cannot pass
    unnoticed.

Bank 9 (channels 241-270) is the designated scratch bank on this model. This
probe does not need to write channel memory, so it only READS from there.

Usage:
    python3 ssp-bpl-probe.py [/dev/cu.xxx] | tee ssp-bpl-probe.txt
    python3 ssp-bpl-probe.py --fake     # pty self-test, no hardware
"""
import glob
import os
import pty
import select
import sys
import termios
import threading
import time

PORT_GLOBS = ["/dev/cu.usbserial-*", "/dev/cu.SLAB_USBtoUART*"]

# Channels sampled before and after the BPL round trip. Spread across banks so
# a step change that only affects one range still shows up.
SAMPLE_CHANNELS = [1, 31, 61, 121, 241, 300]


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
    """One command, one response. The wire is \\r-terminated and not pipelined."""
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


def fields(resp, cmd_name):
    parts = [p.strip() for p in resp.split(",")]
    if parts and parts[0].upper() == cmd_name.upper():
        parts = parts[1:]
    return parts


# ---------------------------------------------------------------- fake radio


def fake_radio(fd, stop):
    """Minimal BC75XLT stand-in. Enough to exercise every branch below."""
    state = {"prg": False, "bpl": "0"}
    buf = b""
    while not stop.is_set():
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return
        if not chunk:
            return
        buf += chunk
        while b"\r" in buf:
            line, buf = buf.split(b"\r", 1)
            cmd = line.decode("ascii", errors="replace").strip()
            if not cmd:
                continue
            head = cmd.split(",")[0].upper()
            parts = cmd.split(",")
            if head == "MDL":
                resp = "MDL,BC75XLT"
            elif head == "VER":
                resp = "VER,Version 1.00.00"
            elif head == "PRG":
                state["prg"] = True
                resp = "PRG,OK"
            elif head == "EPG":
                state["prg"] = False
                resp = "EPG,OK"
            elif head == "BPL":
                if not state["prg"]:
                    resp = "BPL,NG"
                elif len(parts) == 1:
                    resp = f"BPL,{state['bpl']}"
                else:
                    state["bpl"] = parts[1]
                    resp = "BPL,OK"
            elif head == "SSP":
                # Model the plausible failure: SSP absent on this model.
                resp = "SSP,NG" if state["prg"] else "SSP,NG"
            elif head == "CIN":
                if not state["prg"]:
                    resp = "CIN,NG"
                else:
                    idx = parts[1] if len(parts) > 1 else "1"
                    resp = f"CIN,{idx},,01462500,,,0,1,0"
            else:
                resp = f"{head},NG"
            os.write(fd, (resp + "\r").encode("ascii"))


def run_fake():
    master, slave = pty.openpty()
    # A pty echoes by default, which would feed every command straight back as
    # if it were a reply. Raw mode on both ends so the fake behaves like a wire.
    for end in (master, slave):
        attrs = termios.tcgetattr(end)
        attrs[0] = attrs[1] = attrs[3] = 0  # iflag, oflag, lflag
        termios.tcsetattr(end, termios.TCSANOW, attrs)
    stop = threading.Event()
    t = threading.Thread(target=fake_radio, args=(slave, stop), daemon=True)
    t.start()
    print("# FAKE RADIO (pty self-test) -- no hardware touched\n")
    try:
        rc = probe(master, fake=True)
    finally:
        stop.set()
        time.sleep(0.2)
    return rc


# -------------------------------------------------------------------- probe


def probe(fd, fake=False):
    print("=== Phase 0: identity ===")
    # The first command after a fresh open can return ERR -- a CP210x bridge
    # buffers whatever was on the line. Retry once.
    model = show(fd, "MDL")
    if "BC75XLT" not in model:
        model = show(fd, "MDL")
    if "BC75XLT" not in model:
        print(f"ABORT: expected a BC75XLT, got {model!r}. This probe writes; refusing.")
        return 1
    show(fd, "VER")

    print("\n=== Phase 1: SSP and BPL outside program mode ===")
    show(fd, "SSP")
    show(fd, "BPL")

    print("\n=== Phase 2: enter program mode, read everything ===")
    if "OK" not in show(fd, "PRG"):
        print("ABORT: could not enter program mode.")
        return 1

    rc = 0
    try:
        bpl_raw = show(fd, "BPL")
        bpl = fields(bpl_raw, "BPL")
        if not bpl or bpl[0] in ("NG", "ERR", ""):
            print(f"ABORT: could not read the band plan ({bpl_raw!r}); restore would be blind.")
            return 1
        bpl_original = bpl[0]
        print(f"\n--- band plan currently {bpl_original!r} ---")

        print("\n=== Phase 3: SSP shape ===")
        # Unknown index range. Probe bare, then a span wide enough to cover
        # both a 1-based service list and a 0-based one.
        ssp_seen = {}
        ssp_seen["bare"] = show(fd, "SSP")
        for idx in range(0, 12):
            ssp_seen[idx] = show(fd, f"SSP,{idx}")
        answered = [k for k, v in ssp_seen.items() if v and "NG" not in v and "ERR" not in v]
        print(f"\nSSP indices that answered something: {answered if answered else 'NONE'}")

        print("\n=== Phase 4: channel sample BEFORE the BPL round trip ===")
        before = {}
        for ch in SAMPLE_CHANNELS:
            before[ch] = show(fd, f"CIN,{ch}")

        print("\n=== Phase 5: BPL write, staged ===")
        print(f"--- 5a: write the CURRENT value back ({bpl_original}) -- a no-op that still tests the write path")
        noop = show(fd, f"BPL,{bpl_original}")
        if "OK" not in noop:
            print(f"BPL writes are REFUSED on this model (no-op write answered {noop!r}).")
            print("Not attempting a value change. Nothing to restore.")
        else:
            other = "1" if bpl_original == "0" else "0"
            print(f"\n--- 5b: no-op accepted. Changing to {other!r}, then restoring.")
            changed = show(fd, f"BPL,{other}")
            readback = show(fd, "BPL")
            got = fields(readback, "BPL")
            got = got[0] if got else ""
            print(f"wrote {other!r} -> read back {got!r}  ({'PERSISTED' if got == other else 'DID NOT PERSIST'})")

            print(f"\n--- 5c: restoring {bpl_original!r}")
            show(fd, f"BPL,{bpl_original}")
            final = fields(show(fd, "BPL"), "BPL")
            final = final[0] if final else ""
            if final == bpl_original:
                print(f"RESTORED to {final!r}")
            else:
                rc = 1
                print(f"*** RESTORE FAILED: band plan is {final!r}, expected {bpl_original!r} ***")

        print("\n=== Phase 6: channel sample AFTER, diffed against before ===")
        drift = 0
        for ch in SAMPLE_CHANNELS:
            after = show(fd, f"CIN,{ch}")
            if after != before[ch]:
                drift += 1
                print(f"  *** CH{ch} CHANGED ***")
                print(f"      before: {before[ch]!r}")
                print(f"      after:  {after!r}")
        if drift == 0:
            print(f"\nNo drift: all {len(SAMPLE_CHANNELS)} sampled channels identical before and after.")
        else:
            rc = 1
            print(f"\n*** {drift} sampled channel(s) changed across the BPL round trip ***")
    finally:
        print("\n=== Phase 7: leaving program mode ===")
        show(fd, "EPG")

    return rc


def main():
    if "--fake" in sys.argv:
        return run_fake()

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
    try:
        return probe(fd)
    finally:
        os.close(fd)


if __name__ == "__main__":
    sys.exit(main())
