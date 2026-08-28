#!/usr/bin/env python3
"""BC75XLT: does the firmware move the priority flag within a bank by itself?

stdlib only (termios). The last question in #479.

Established on hardware 2026-08-28 (findings.md §7): this model has no `DCH`,
and an in-place priority 1->0 `CIN` write is refused silently. Bearpaw cannot
clear a priority channel here by any known means.

But the owner's manual's keypad procedure for designating one has NO clear step
-- select the channel, Func+Pgm, Func+Pri, done -- which suggests the firmware
moves the flag within a bank itself. If it does, Bearpaw's clear-then-set swap
is imposing a rule the hardware already enforces, and the clear is exactly the
step that cannot work. The fix would be to skip it.

EVERYTHING HERE HAPPENS IN BANK 9 -- channels 241-270 on this model, which the
owner has designated a scratch bank. That is what makes the probe possible in
this form. An earlier draft worked only with state it happened to find, which
meant hunting for a spare priority channel and accepting an unrecoverable
two-priority bank if the firmware turned out not to auto-swap. Given a bank it
may freely write, the probe instead CONSTRUCTS its own precondition and does not
care how it is left.

Three outcomes:

  A. SET REFUSED -- priority is read-only on this model. Nothing changed.
  B. SET ACCEPTED, old channel cleared -- the firmware auto-swaps. Bearpaw's
     clear-then-set is imposing a rule the hardware already keeps.
  C. SET ACCEPTED, old channel KEPT it -- no auto-swap. Priority is
     write-once from the app on this model.

It still prints the full before-state and attempts a restore. A disposable bank
is not a reason to be sloppy, and the transcript is the record -- but no outcome
here is a problem, so nothing shouts.

Both channels are in the SAME bank because the manual's rule is one priority
channel per bank; a pair straddling a boundary would prove nothing either way.

It also incidentally answers whether `CIN` writes work at all on this model
(#478): programming a bank 9 channel from scratch is the first thing it does.

Usage:
    python3 priority-swap-probe.py [/dev/cu.xxx] | tee priority-swap-probe.txt
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

CHANNELS_PER_BANK = 30  # BC75XLT; the probe refuses to run against anything else
SCRATCH_BANK = 9  # 1-based. Designated disposable by the owner; see the header.

# Written into bank 9 if it has too few programmed channels to work with. Both
# are frequencies this radio already holds in bank 1, so both are on-step under
# whatever band plan is active -- a made-up frequency could be off-step, and the
# resulting ERR would read as "CIN writes are broken" rather than "that value
# was illegal".
SEED_FREQUENCIES = ["01451300", "01469550"]


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
    if len(parts) < 9 or parts[0].upper() != "CIN" or parts[1] != str(index):
        return None
    return parts[2:9]


def read_ch(fd, index, label=""):
    fields = cin_fields(show(fd, f"CIN,{index}"), index)
    if fields is not None and label:
        print(f"    {label}: priority={fields[6]}")
    return fields


def write_priority(fd, index, fields, value):
    """Rewrite a channel changing only its priority field.

    Reserved fields are rebuilt from the read and go out empty (CLAUDE.md
    pitfall #9) -- a value in a reserved slot risks the format error that
    aborts the whole set command.
    """
    payload = list(fields)
    payload[6] = value
    return show(fd, f"CIN,{index}," + ",".join(payload))


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
        first = (SCRATCH_BANK - 1) * CHANNELS_PER_BANK + 1
        last = SCRATCH_BANK * CHANNELS_PER_BANK
        print(f"\n=== Phase 1: survey bank {SCRATCH_BANK} (channels {first}-{last}) ===")
        bank = {}
        for idx in range(first, last + 1):
            fields = cin_fields(send(fd, f"CIN,{idx}"), idx)
            if fields is None:
                continue
            bank[idx] = fields
            programmed = fields[1].strip("0") != ""
            if programmed or fields[6] == "1":
                print(f"CIN,{idx:<4} {fields}")
        if len(bank) < 2:
            print(f"ABORT: could not read bank {SCRATCH_BANK}. Nothing written.")
            return 1
        programmed = [i for i, f in bank.items() if f[1].strip("0") != ""]
        holders = [i for i, f in bank.items() if f[6] == "1"]
        print(f"--- {len(programmed)} programmed, priority on {holders or 'none'}")

        print("\n=== Phase 2: build the precondition ===")
        # Two programmed channels, exactly one of them holding priority. Bank 9
        # is disposable, so this is constructed rather than searched for.
        targets = sorted(programmed)[:2]
        for offset, idx in enumerate(range(first, first + 2)):
            if idx in targets:
                continue
            seed = list(bank[idx])
            seed[1] = SEED_FREQUENCIES[offset % len(SEED_FREQUENCIES)]
            # An empty slot reports lockout=1 on this model, and inheriting that
            # would leave a locked-out channel behind for no reason. Delay is a
            # boolean here, so 0 is valid.
            seed[4] = "0"
            seed[5] = "0"
            seed[6] = "0"
            print(f"--- programming CIN,{idx} with {seed[1]} (was empty)")
            show(fd, f"CIN,{idx}," + ",".join(seed))
            back = read_ch(fd, idx)
            if back is None or back[1] != seed[1]:
                print(f"!!! CIN write did not take on channel {idx}: {back}")
                print("!!! That is a finding in itself -- CIN writes may not work here.")
                return 1
            bank[idx] = back
            targets = sorted(set(targets) | {idx})
        targets = sorted(targets)[:2]
        holder, partner = targets[0], targets[1]
        holder_fields, partner_fields = bank[holder], bank[partner]

        if holder_fields[6] != "1":
            print(f"--- designating CIN,{holder} as the bank's priority channel")
            write_priority(fd, holder, holder_fields, "1")
            holder_fields = read_ch(fd, holder, f"CIN,{holder}")
            if holder_fields is None or holder_fields[6] != "1":
                print("\n=== OUTCOME A: SET REFUSED ===")
                print("--- The priority field cannot be SET over the wire either, so it")
                print("--- is read-only on this model: Bearpaw should hide the control.")
                print("--- Nothing else to test.")
                return 0
        # Any other priority channel in this bank would confound the result.
        for idx in sorted(bank):
            if idx != holder and bank[idx][6] == "1":
                print(f"--- note: CIN,{idx} also holds priority; clearing is known to fail,")
                print("--- so the auto-swap reading below is about the FIRST holder only.")

        print(f"\n--- BEFORE")
        print(f"    CIN,{holder}  holds priority : {holder_fields}")
        print(f"    CIN,{partner}  partner        : {partner_fields}")

        print(f"\n=== Phase 3: designate CIN,{partner} as the bank's priority channel ===")
        write_priority(fd, partner, partner_fields, "1")
        after_partner = read_ch(fd, partner, f"CIN,{partner} after the write")
        after_holder = read_ch(fd, holder, f"CIN,{holder} after the write")

        if not (after_partner and after_partner[6] == "1"):
            print("\n=== OUTCOME A: SET REFUSED ===")
            print("--- Priority is read-only on this model: it can be neither set nor")
            print("--- cleared over the wire. Bearpaw should hide the control.")
            return 0

        if not (after_holder and after_holder[6] == "1"):
            print("\n=== OUTCOME B: THE FIRMWARE AUTO-SWAPS ===")
            print(f"--- CIN,{holder} dropped priority on its own when CIN,{partner} took it.")
            print("--- One per bank is enforced by the radio. Bearpaw's clear-then-set is")
            print("--- imposing a rule the hardware already keeps, and the clear is exactly")
            print("--- the step that cannot work here. Skip it: just SET.")
        else:
            print("\n=== OUTCOME C: NO AUTO-SWAP ===")
            print(f"--- CIN,{partner} took priority and CIN,{holder} KEPT it. The firmware")
            print("--- does not enforce one-per-bank, so Bearpaw must clear -- and cannot.")
            print("--- Priority is write-once from the app on this model.")
            print("--- (Harmless here: this is the scratch bank.)")

        print("\n=== Phase 4: restore, best effort ===")
        # A just-written flag might behave differently from a factory one. Worth
        # knowing either way, and free to try.
        write_priority(fd, partner, partner_fields, "0")
        cleared_directly = read_ch(fd, partner, f"CIN,{partner} after the clear attempt")
        write_priority(fd, holder, holder_fields, "1")
        # Read the partner AFTER restoring the holder, not before. On an
        # auto-swapping radio the holder's write is what clears the partner, so
        # reading first reports a state that the very next command undoes -- the
        # first hardware run printed "both hold priority" when the radio had
        # already swapped correctly.
        final_holder = read_ch(fd, holder, f"CIN,{holder}")
        final_partner = read_ch(fd, partner, f"CIN,{partner}")
        if cleared_directly and cleared_directly[6] == "0":
            print("--- NOTE: the in-place clear WORKED on a just-set flag, though it is")
            print("--- refused on a factory one (findings.md §7). Worth a follow-up.")
        else:
            print(f"--- the direct clear of CIN,{partner} was refused, as expected.")
        print(f"--- left as: CIN,{holder}={final_holder}, CIN,{partner}={final_partner}")
        print(f"--- Bank {SCRATCH_BANK} is the scratch bank; no recovery needed.")
    finally:
        show(fd, "EPG")
        os.close(fd)
    return 0


sys.exit(main())
