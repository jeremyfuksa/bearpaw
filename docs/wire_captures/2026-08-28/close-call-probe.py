#!/usr/bin/env python3
"""BC75XLT Close Call probe: which CLC mask positions are real, and which modes exist.

stdlib only (termios). Settles the three open questions behind the Device tab's
Close Call page on this model. Every one of them is a WRITE mapping, which is
why inference is not good enough here -- see #241, where two references agreed
on the Close Call mode digits and both were wrong for this app, so "CC Priority"
put the radio in DND until a capture said otherwise.

  1. Band mask positions. The BC125AT is [VHF Low, Air, VHF High, UHF, 800MHz].
     The BC75XLT vendor spec's bit diagram is [VHF Low, Air, VHF High, RSV, UHF]
     -- positions 4 and 5 differ, and that model has no 800 MHz coverage at all
     (owner's manual: four bands, keys 1-4). Bearpaw uses the BC125AT order for
     both, so on a BC75XLT the "UHF" switch would write the reserved slot and
     the "800 MHz" switch would be the real UHF.

     The experiment does not need to observe reception: writing all five ones
     and reading back says which positions the radio KEEPS. A slot forced to 0
     is the reserved one.

  2. Mode 3 (`CC Only`). Present on BC125AT hardware (clc-mode-probe-cc-only.txt)
     but not in this model's spec (0:OFF / 1:CC PRI / 2:CC DND) and not in its
     manual, which describes three operation modes. The dropdown offers it and
     the backend validates 0..=3 for every model.

  3. Field 5 (`hit_scan`, the "Lockout Hits While Scanning" switch). `[RSV]` per
     the spec, and the 2026-08-26 capture shows it empty: `CLC,2,1,1,11101,`.

THIS SCRIPT WRITES. It reads the full CLC line first, prints it, restores it at
the end, and verifies the restore. Mode, alert beep, and alert light are carried
through unchanged on every write except the one that deliberately probes mode 3.

Usage:
    python3 close-call-probe.py [/dev/cu.xxx] | tee close-call-probe.txt
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


def clc_fields(resp):
    """CLC payload as [mode, beep, light, mask, hit_scan], or None if unusable."""
    parts = [p.strip() for p in resp.split(",")]
    if not parts or parts[0].upper() != "CLC":
        return None
    parts = parts[1:]
    if len(parts) < 4:
        return None
    while len(parts) < 5:
        parts.append("")
    return parts[:5]


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
        print("\n=== Phase 1: read first (restore depends on this) ===")
        original = clc_fields(show(fd, "CLC"))
        if not original:
            print("ABORT: could not parse CLC. Nothing written.")
            return 1
        mode, beep, light, mask, hit = original
        print(f"--- mode={mode!r} beep={beep!r} light={light!r} "
              f"mask={mask!r} field5={hit!r}")
        if len(mask) != 5 or set(mask) - {"0", "1"}:
            print(f"ABORT: mask {mask!r} is not 5 binary digits. Nothing written.")
            return 1

        print("\n=== Phase 2: which mask positions does the radio keep? ===")
        # All five on. A position the radio forces back to 0 is the reserved
        # one. Under the BC125AT layout all five would stick; under this
        # model's spec, position 4 comes back 0.
        show(fd, f"CLC,{mode},{beep},{light},11111,{hit}")
        after = clc_fields(show(fd, "CLC"))
        if after:
            got = after[3]
            print(f"--- wrote 11111 -> read back {got!r}")
            if got == "11111":
                print("--- ALL FIVE KEPT: no reserved position; BC125AT layout holds.")
            elif len(got) == 5:
                dead = [i + 1 for i, c in enumerate(got) if c == "0"]
                print(f"--- FORCED TO 0 AT POSITION(S) {dead} -> reserved there.")
                print("--- [4] alone matches the vendor spec: "
                      "1 VHF Low, 2 Air, 3 VHF High, 4 RSV, 5 UHF.")

        print("\n=== Phase 3: does mode 3 (CC Only) exist? ===")
        # Spec says 0-2. If this ERRs, the dropdown must not offer CC Only here.
        show(fd, f"CLC,3,{beep},{light},{mask},{hit}")
        probe = clc_fields(show(fd, "CLC"))
        if probe:
            print(f"--- after writing mode 3, radio reports mode {probe[0]!r} "
                  f"({'ACCEPTED' if probe[0] == '3' else 'REJECTED'})")

        print("\n=== Phase 4: is field 5 (hit_scan) reserved? ===")
        show(fd, f"CLC,{mode},{beep},{light},{mask},1")
        five = clc_fields(show(fd, "CLC"))
        if five:
            print(f"--- wrote 1 into field 5 -> read back {five[4]!r} "
                  f"({'RESERVED' if five[4] in ('', '0') else 'SETTABLE'})")

        print("\n=== Phase 5: restore ===")
        show(fd, f"CLC,{mode},{beep},{light},{mask},{hit}")
        final = clc_fields(show(fd, "CLC"))
        if final and final[:4] == original[:4]:
            print(f"--- CLC holds its original settings: {original}")
        else:
            print(f"!!! RESTORE FAILED. CLC is {final}, was {original}.")
            print("!!! Reset Close Call from the scanner: Func + hold the CC key.")
    finally:
        show(fd, "EPG")
        os.close(fd)
    return 0


sys.exit(main())
