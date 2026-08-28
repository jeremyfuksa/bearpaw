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

Three outcomes, and only one of them costs anything:

  A. SET REFUSED -- priority is read-only on this model. Nothing changed.
  B. SET ACCEPTED, old channel cleared -- the firmware auto-swaps. Restoring is
     the same operation in reverse, so the probe undoes itself.
  C. SET ACCEPTED, old channel NOT cleared -- the bank now holds two priority
     channels, and per the finding above Bearpaw cannot clear either. Recovery
     is the scanner's own keypad.

READ THIS BEFORE RUNNING. Outcome C leaves a state this probe cannot undo. It
is run with that understood. Everything else is arranged to make C both
unlikely to be misread and loud when it happens: the probe prints the full
before-state, attempts every restore avenue it has, and re-reads at the end
rather than assuming a write took.

The two channels are chosen in the SAME bank -- 30 channels per bank on this
model -- because the manual's rule is one priority channel per bank. A pair
straddling a bank boundary would prove nothing either way.

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
SCAN_LIMIT = 60


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
        print("\n=== Phase 1: find a priority channel and a partner in the SAME bank ===")
        holder = holder_fields = None
        for idx in range(1, SCAN_LIMIT + 1):
            fields = read_ch(fd, idx)
            if fields and fields[1].strip("0") != "" and fields[6] == "1":
                holder, holder_fields = idx, fields
                break
        if holder is None:
            print(f"ABORT: no programmed priority channel in 1..{SCAN_LIMIT}. Nothing written.")
            return 1

        bank = (holder - 1) // CHANNELS_PER_BANK
        partner = partner_fields = None
        for idx in range(bank * CHANNELS_PER_BANK + 1, (bank + 1) * CHANNELS_PER_BANK + 1):
            if idx == holder:
                continue
            fields = read_ch(fd, idx)
            if fields and fields[1].strip("0") != "" and fields[6] == "0":
                partner, partner_fields = idx, fields
                break
        if partner is None:
            print(f"ABORT: no programmed non-priority partner in bank {bank + 1}. Nothing written.")
            return 1

        print(f"\n--- BEFORE (bank {bank + 1}, channels "
              f"{bank * CHANNELS_PER_BANK + 1}-{(bank + 1) * CHANNELS_PER_BANK})")
        print(f"    CIN,{holder}  holds priority : {holder_fields}")
        print(f"    CIN,{partner}  partner        : {partner_fields}")
        print("--- If anything below goes wrong, those two lines are the state to restore.")

        print(f"\n=== Phase 2: designate CIN,{partner} as the bank's priority channel ===")
        write_priority(fd, partner, partner_fields, "1")
        after_partner = read_ch(fd, partner, f"CIN,{partner} after the write")
        after_holder = read_ch(fd, holder, f"CIN,{holder} after the write")

        partner_set = bool(after_partner) and after_partner[6] == "1"
        holder_kept = bool(after_holder) and after_holder[6] == "1"

        if not partner_set:
            print("\n=== OUTCOME A: SET REFUSED ===")
            print("--- The priority field is read-only on this model: neither set nor")
            print("--- cleared over the wire. Bearpaw should hide the priority control.")
            print("--- Nothing changed; no restore needed.")
            return 0

        if not holder_kept:
            print("\n=== OUTCOME B: THE FIRMWARE AUTO-SWAPS ===")
            print(f"--- CIN,{holder} dropped priority on its own when CIN,{partner} took it.")
            print("--- One per bank is enforced by the radio. Bearpaw's clear-then-set")
            print("--- is imposing a rule the hardware already keeps, and the clear is")
            print("--- exactly the step that cannot work here. Skip it: just SET.")

            print("\n=== Phase 3: restore (the same operation in reverse) ===")
            write_priority(fd, holder, holder_fields, "1")
            final_holder = read_ch(fd, holder, f"CIN,{holder} restored")
            final_partner = read_ch(fd, partner, f"CIN,{partner} restored")
            ok = (
                final_holder == holder_fields
                and final_partner is not None
                and final_partner[6] == "0"
            )
            if ok:
                print(f"--- restored: CIN,{holder} priority=1, CIN,{partner} priority=0")
            else:
                print(f"!!! RESTORE INCOMPLETE. CIN,{holder}={final_holder}, "
                      f"CIN,{partner}={final_partner}")
                print(f"!!! Wanted CIN,{holder}={holder_fields} and CIN,{partner} priority=0.")
                print(f"!!! Designate channel {holder} from the keypad: select it, "
                      "Func+Pgm, then Func+Pri.")
            return 0

        print("\n=== OUTCOME C: TWO PRIORITY CHANNELS IN ONE BANK ===")
        print(f"--- CIN,{partner} took priority and CIN,{holder} KEPT it. The firmware")
        print("--- does not auto-swap, so Bearpaw must clear -- and it cannot.")
        print("--- Priority is effectively write-once from the app on this model.")

        print("\n=== Phase 3: attempting every restore avenue there is ===")
        print("--- (an in-place clear is known to be refused; trying anyway, since a")
        print("---  just-written flag might behave differently from a factory one)")
        write_priority(fd, partner, partner_fields, "0")
        recheck = read_ch(fd, partner, f"CIN,{partner} after the clear attempt")
        if recheck and recheck[6] == "0":
            print(f"--- UNEXPECTED: the clear WORKED on CIN,{partner}.")
            print("--- A just-set priority flag can be cleared even though a factory one")
            print("--- cannot. Worth a follow-up probe; the bank is back to one channel.")
        else:
            print(f"!!! Could not clear CIN,{partner}. Bank {bank + 1} now has TWO")
            print(f"!!! priority channels: {holder} and {partner}.")
            print(f"!!! FIX ON THE SCANNER: select channel {holder}, press Func+Pgm,")
            print("!!! then Func+Pri to re-designate it as the bank's priority channel.")
            print(f"!!! Original state was CIN,{holder}={holder_fields}")
            print(f"!!!                    CIN,{partner}={partner_fields}")
    finally:
        show(fd, "EPG")
        os.close(fd)
    return 0


sys.exit(main())
