#!/usr/bin/env python3
"""BC75XLT priority-clear probe: does DCH exist, and can priority be cleared in place?

stdlib only (termios). Settles the mechanism behind `clear_channel_priority_locked`
on this model.

Background. On a BC125AT the firmware REFUSES an in-place priority 1->0 `CIN`
write (#203 probe), so the only way to clear a priority channel is `DCH,<n>`
(wipe to factory-empty) followed by a full `CIN` rewrite with priority=0. That
was verified on BC125AT hardware 2026-08-03 (#251) and is what Bearpaw does --
unconditionally, for every model.

But `DCH` is ABSENT from the BC75XLT vendor spec's 20-command table. Every other
memory-access command is in it (`CIN`, `SCG`, `CSG`, `CSP`, `GLF`/`LOF`/`ULF`),
so the omission looks deliberate rather than an oversight. If `DCH` errors here,
then moving a priority channel between slots fails on this model: the clear step
aborts the swap by design (the priority-swap atomicity guard), so the user gets
an error and nothing moves.

Two questions, in the order that makes the second one cheap:

  1. Does an in-place priority 1->0 `CIN` write work on THIS model? If yes, `DCH`
     is unnecessary here and the fix is to skip it -- simpler AND less
     destructive than what the BC125AT needs.

  2. Does `DCH` exist at all?

THIS SCRIPT WRITES. Both tests are chosen to be recoverable:

  - The `DCH` test targets an EMPTY channel (frequency 0). If the command works,
    nothing is lost -- the slot was already factory-empty. If it errors, nothing
    happened.
  - The in-place test reads the channel first, prints it, and writes the
    original value back afterwards, verifying the restore.

It manufactures no state: if no programmed priority channel exists, phase 3 is
skipped rather than creating one. Setting priority on a scanner that may enforce
one-per-bank in firmware is a side effect this probe has no business having.

Usage:
    python3 priority-clear-probe.py [/dev/cu.xxx] | tee priority-clear-probe.txt
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

# Where to look for each target, and why the two searches run in opposite
# directions.
#
# The first run of this probe scanned 1..60 for both and found no empty slot:
# every channel in that range is programmed on the dev unit, so the DCH test
# skipped and the question went unanswered. Empty slots live at the TOP of
# memory -- the 2026-08-26 capture shows 299 and 300 factory-empty -- while the
# factory layout puts priority channels low. Search each from the end it is
# actually likely to be found, and the whole probe costs a couple of dozen
# round-trips instead of hundreds.
CHANNEL_COUNT = 300  # BC75XLT; the probe refuses to run against anything else
PRIORITY_SCAN_LIMIT = 60  # searched upward from 1
EMPTY_SCAN_DEPTH = 60  # searched downward from CHANNEL_COUNT


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


def cin_fields(resp, index):
    """CIN payload as [rsv, freq, rsv, rsv, delay, lockout, priority], or None."""
    parts = [p.strip() for p in resp.split(",")]
    if len(parts) < 9 or parts[0].upper() != "CIN":
        return None
    if parts[1] != str(index):
        return None
    return parts[2:9]


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

    if "OK" not in show(fd, "PRG"):
        print("ABORT: could not enter program mode.")
        os.close(fd)
        return 1
    try:
        print("\n=== Phase 1: find targets ===")
        priority_target = None
        empty_target = None

        # Priority channels sit low in the factory layout.
        print(f"--- searching 1..{PRIORITY_SCAN_LIMIT} upward for a priority channel")
        for idx in range(1, PRIORITY_SCAN_LIMIT + 1):
            fields = cin_fields(send(fd, f"CIN,{idx}"), idx)
            if fields is None:
                continue
            if fields[1].strip("0") != "" and fields[6] == "1":
                priority_target = (idx, fields)
                print(f"CIN,{idx:<3} priority channel  -> {fields}")
                break

        # Empty slots sit at the top: 299 and 300 were factory-empty on
        # 2026-08-26. Searching upward from 1 found none in 60 tries.
        low = max(1, CHANNEL_COUNT - EMPTY_SCAN_DEPTH + 1)
        print(f"--- searching {CHANNEL_COUNT}..{low} downward for an empty slot")
        for idx in range(CHANNEL_COUNT, low - 1, -1):
            fields = cin_fields(send(fd, f"CIN,{idx}"), idx)
            if fields is None:
                continue
            if fields[1].strip("0") == "":
                empty_target = (idx, fields)
                print(f"CIN,{idx:<3} empty slot        -> {fields}")
                break

        print("\n=== Phase 2: does DCH exist? ===")
        # Targets an ALREADY-EMPTY slot, so a working DCH destroys nothing and a
        # rejected one changes nothing.
        if empty_target is None:
            print(f"SKIP: no empty channel in the top {EMPTY_SCAN_DEPTH}; refusing to DCH a programmed one.")
            print("SKIP: free one slot from the scanner's keypad and re-run.")
        else:
            idx, before = empty_target
            resp = show(fd, f"DCH,{idx}")
            after = cin_fields(show(fd, f"CIN,{idx}"), idx)
            verdict = "EXISTS" if "OK" in resp.upper() else "ABSENT"
            print(f"--- DCH on an empty slot: {verdict} ({resp!r})")
            if after != before:
                print(f"!!! the empty slot CHANGED: {before} -> {after}")

        print("\n=== Phase 3: can priority be cleared IN PLACE? ===")
        # The BC125AT refuses this, which is the whole reason DCH is used there.
        if priority_target is None:
            print(f"SKIP: no programmed priority channel in 1..{PRIORITY_SCAN_LIMIT}.")
            print("SKIP: not creating one -- the radio may enforce one-per-bank itself.")
        else:
            idx, original = priority_target
            # Reserved fields go out EMPTY (CLAUDE.md pitfall #9); rebuild the
            # payload from the read and change only the priority field.
            cleared = list(original)
            cleared[6] = "0"
            show(fd, f"CIN,{idx}," + ",".join(cleared))
            after = cin_fields(show(fd, f"CIN,{idx}"), idx)
            if after is None:
                print("!!! read-back unparseable; restoring anyway.")
            else:
                took = after[6] == "0"
                print(f"--- in-place priority 1->0: {'ACCEPTED' if took else 'REFUSED'}")
                print("--- ACCEPTED means this model needs no DCH: clear in place.")
                print("--- REFUSED means it behaves like a BC125AT and needs DCH,")
                print("--- which phase 2 says whether it even has.")

            print("\n=== Phase 4: restore ===")
            show(fd, f"CIN,{idx}," + ",".join(original))
            final = cin_fields(show(fd, f"CIN,{idx}"), idx)
            if final == original:
                print(f"--- CIN,{idx} holds its original values: {original}")
            else:
                print(f"!!! RESTORE FAILED. CIN,{idx} is {final}, was {original}.")
                print(f"!!! Reprogram channel {idx} from the scanner's keypad.")
    finally:
        show(fd, "EPG")
        os.close(fd)
    return 0


sys.exit(main())
