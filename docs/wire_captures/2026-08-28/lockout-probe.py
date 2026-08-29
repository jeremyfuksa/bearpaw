#!/usr/bin/env python3
"""BC75XLT global-lockout probe: GLF walk semantics, plus LOF and ULF.

stdlib only (termios). Closes the last subtab the Device tab audit passed on
the strength of the vendor command table alone.

Three things to settle.

1. DOES THE BARE `GLF` CURSOR ITERATE HERE? Bearpaw's walk sends a bare `GLF`
   repeatedly and reads `GLF,<freq8>` per entry until `GLF,-1`. That was
   verified on a BC125AT (2026-07-08). But this model's spec documents
   `GLF,[***]` -- "don't care, to retrieve 1'st L/O frequency" -- and on a
   BC125AT that parameterized form answers a payload-less `GLF,OK` and does
   NOT iterate. That mismatch was bug #142, where at most one lockout was ever
   read. If the two models want different forms, the same bug is live here in
   the other direction and the Locked Channels page shows a truncated list.

2. DOES `ULF` WORK? Bearpaw's "clear lockouts" sends it per entry.

3. DOES `LOF` WORK? Bearpaw never sends it. It is probed only because it is the
   safe way to test `ULF`: add a synthetic lockout, remove it, net zero. Testing
   `ULF` against a real user lockout would mean destroying one to learn that the
   command works.

THIS SCRIPT WRITES, but only ever to a lockout entry it created itself. Existing
lockouts are read and printed before anything else, and never removed. If `LOF`
fails, the `ULF` test is skipped rather than falling back to a real entry.

CONTROL CASE. The walk is run twice with no writes in between before anything is
concluded. If the cursor does not auto-reset after `-1`, the second walk comes
back short and every later phase would misread -- "the lockout vanished" when it
never did. The probe aborts on that rather than reporting a fiction.

Usage:
    python3 lockout-probe.py [/dev/cu.xxx] | tee lockout-probe.txt
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

# The firmware caps the list at 100 on a BC125AT; 110 bounds a runaway loop.
WALK_LIMIT = 110

# Candidate frequencies for the synthetic lockouts, in units of 100 Hz. All are
# band edges inside this model's coverage (25-54, 108-174, 406-512 MHz) AND
# appear verbatim in the factory custom-search ranges read off real hardware,
# so each is representable under either band plan. Every one not already locked
# out is used, because a MULTI-entry list is the point: the first run of this
# probe found an empty list, so the cursor was only ever seen advancing across
# one entry. That proves it advances; it does not prove it walks a list.
CANDIDATES = ["00250000", "00540000", "01080000", "01740000", "04060000", "05120000"]


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
    print(f"{cmd:<20} -> {resp!r}")
    return resp


def glf_payload(resp):
    """The payload of a GLF reply: a frequency string, '-1', 'OK', or None."""
    parts = [p.strip() for p in resp.split(",")]
    if not parts or parts[0].upper() != "GLF":
        return None
    return parts[1] if len(parts) > 1 else ""


def walk(fd, label, verbose=False):
    """Bare-GLF cursor walk, exactly as Bearpaw does it."""
    found = []
    for _ in range(WALK_LIMIT):
        resp = send(fd, "GLF")
        if verbose:
            print(f"{'GLF':<20} -> {resp!r}")
        payload = glf_payload(resp)
        if payload is None or payload in ("", "-1", "OK"):
            break
        found.append(payload)
    print(f"--- {label}: {len(found)} entr{'y' if len(found) == 1 else 'ies'} {found}")
    return found


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

    print("\n=== Phase 1: is GLF program-mode only? ===")
    show(fd, "GLF")  # expect NG outside PRG

    if "OK" not in show(fd, "PRG"):
        print("ABORT: could not enter program mode.")
        os.close(fd)
        return 1
    try:
        print("\n=== Phase 2: the bare-GLF walk, as Bearpaw sends it ===")
        original = walk(fd, "walk A", verbose=True)

        print("\n=== Phase 3: CONTROL -- does the cursor auto-reset? ===")
        # No writes in between. A short second walk means the cursor does not
        # rewind after -1, and every later phase would misread.
        again = walk(fd, "walk B")
        if again != original:
            print("!!! The cursor did NOT auto-reset -- walk B differs from walk A.")
            print("!!! Every later phase would misread this. Nothing written; stopping.")
            return 1
        print("--- cursor rewinds after -1; the walk is repeatable.")

        print("\n=== Phase 4: does the parameterized GLF form iterate? ===")
        # This model's spec documents `GLF,[***]` to retrieve the first entry.
        # On a BC125AT that form answers a payload-less `GLF,OK` and does not
        # iterate -- bug #142. Reads do not mutate, so this is safe either way.
        resp = show(fd, "GLF,***")
        payload = glf_payload(resp)
        if payload in ("OK", ""):
            print("--- payload-less OK: does NOT iterate. Same as the BC125AT;")
            print("--- Bearpaw's bare-GLF walk is correct for this model.")
        elif payload == "-1":
            print("--- returned -1: the list is empty, or the form resets to a spent cursor.")
        else:
            print(f"--- returned a frequency ({payload!r}): this form DOES iterate here.")
            print("--- Bearpaw's bare-GLF walk may need the parameterized form on this model.")
        walk(fd, "walk C (list intact after the parameterized read?)")

        print("\n=== Phase 5: LOF -- build a MULTI-ENTRY list ===")
        targets = [c for c in CANDIDATES if c not in original]
        if not targets:
            print(f"SKIP: every candidate is already locked out ({CANDIDATES}).")
            print("SKIP: refusing to touch an existing entry to make room.")
            return 0
        print(f"--- adding {len(targets)}: " +
              ", ".join(f"{int(t) / 10000.0:.4f}" for t in targets))
        for t in targets:
            show(fd, f"LOF,{t}")
        after_lof = walk(fd, "walk D (after LOF)", verbose=True)
        added = [t for t in targets if t in after_lof]
        print(f"--- LOF: added {len(added)} of {len(targets)}")
        print(f"--- list length {len(original)} -> {len(after_lof)}")
        if len(after_lof) < 2:
            print("!!! Fewer than two entries; the multi-entry walk is still unproven.")
        else:
            # The whole point of this run. A cursor that returns one entry and
            # stops would look identical to a working walk on a 1-entry list.
            print(f"--- MULTI-ENTRY WALK: {len(after_lof)} entries returned, then -1.")
            order = "insertion" if after_lof[-len(added):] == added else (
                "sorted" if after_lof == sorted(after_lof) else "neither")
            print(f"--- order returned: {order}")

        if not added:
            print("\n=== Phase 6: ULF -- SKIPPED ===")
            print("SKIP: LOF added nothing, so there is no synthetic entry to remove.")
            print("SKIP: not testing ULF against a real lockout -- that would destroy one.")
            return 0

        print("\n=== Phase 6: ULF -- remove them again ===")
        # Every target this run ADDED, not just the ones the walk reported back.
        # If the walk under-reports -- which is precisely the failure this run
        # exists to detect -- trusting it for cleanup would leave the entries it
        # could not see behind on the radio.
        for t in targets:
            show(fd, f"ULF,{t}")
        after_ulf = walk(fd, "walk E (after ULF)")
        leftover = [t for t in targets if t in after_ulf]
        print(f"--- ULF: {len(targets) - len(leftover)} of {len(targets)} gone from the walk")

        print("\n=== Phase 7: verify net zero ===")
        if after_ulf == original:
            print(f"--- lockout list is back to its original {len(original)} entr"
                  f"{'y' if len(original) == 1 else 'ies'}: {original}")
        else:
            print(f"!!! LIST CHANGED. Now {after_ulf}, was {original}.")
            print("!!! Remove any of these from the scanner's own lockout list if they remain:")
            print(f"!!!   {targets}")
    finally:
        show(fd, "EPG")
        os.close(fd)
    return 0


sys.exit(main())
