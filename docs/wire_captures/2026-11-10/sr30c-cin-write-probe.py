#!/usr/bin/env python3
"""SR30C CIN write probe (#846, CIN rows only). WRITES CHANNEL MEMORY.

Target: bank 9, channels 401-408 -- the pre-authorized disposable bank.
Never sends CLR or DCH. Every touched slot's before-state is recorded and
written back at the end, then re-read and compared.

Answers, per CIN field, whether the SR30C keeps it, ignores it, or rejects the
whole write (vendor spec: one bad field aborts the WHOLE CIN write, so every
test writes a frequency too, and the readback says which of the three happened).

stdlib only. Usage: sr30c-cin-write-probe.py <port>
"""
import os, sys, time, termios, select

FREQ = "01462500"  # 146.2500 MHz, inside the SR30C's VHF coverage
SLOTS = list(range(401, 409))

# (slot, label, payload after "CIN,<slot>,")  fields: name,freq,mod,tone,delay,lockout,pri
TESTS = [
    (402, "baseline: freq only, reserved fields empty", f",{FREQ},,,0,0,0"),
    (403, "name (has_alpha_tags)",                       f"BEARPAW TEST,{FREQ},,,0,0,0"),
    (404, "modulation FM (has_per_channel_modulation)",  f",{FREQ},FM,,0,0,0"),
    (405, "tone code 64 = 67.0 Hz (has_tone_squelch)",   f",{FREQ},,64,0,0,0"),
    (406, "delay 1 (valid_delays)",                      f",{FREQ},,,1,0,0"),
    (406, "delay 2 (BC125AT-only value?)",               f",{FREQ},,,2,0,0"),
    (406, "delay -5 (BC125AT-only value?)",              f",{FREQ},,,-5,0,0"),
    (407, "lockout 1",                                   f",{FREQ},,,0,1,0"),
    (408, "priority 1 (does 401 lose its flag?)",        f",{FREQ},,,0,0,1"),
]


def open_port(path):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    cc = list(termios.tcgetattr(fd)[6])
    cc[termios.VMIN] = 0
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW,
                      [0, 0, termios.CS8 | termios.CREAD | termios.CLOCAL, 0,
                       termios.B57600, termios.B57600, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def send(fd, cmd, timeout=2.0, settle=0.12):
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, (cmd + "\r").encode("ascii"))
    deadline, buf = time.time() + timeout, b""
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                buf += os.read(fd, 4096)
            except BlockingIOError:
                continue
            if b"\r" in buf:
                break
    time.sleep(settle)
    resp = buf.decode("ascii", errors="replace").strip("\r")
    print(f"{cmd:<40} -> {resp!r}", flush=True)
    return resp


def read_slot(fd, n):
    """Return the 7 fields after CIN,<n>, or None on a malformed reply."""
    parts = send(fd, f"CIN,{n}").split(",")
    return parts[2:] if len(parts) == 9 and parts[1] == str(n) else None


def main():
    fd = open_port(sys.argv[1])
    time.sleep(0.4)
    mdl = ""
    for _ in range(3):  # pitfall #11: first command after open can ERR
        mdl = send(fd, "MDL")
        if mdl.startswith("MDL,"):
            break
    if mdl != "MDL,SR30C":
        print(f"REFUSING: expected MDL,SR30C, got {mdl!r}")
        return 1
    send(fd, "VER")
    if send(fd, "PRG") != "PRG,OK":
        print("REFUSING: PRG not OK")
        return 1

    try:
        print("\n=== BEFORE: bank 9 slots 401-408 ===")
        before = {n: read_slot(fd, n) for n in SLOTS}
        if any(v is None for v in before.values()):
            print("REFUSING: could not read every slot's before-state")
            return 1
        for n, v in before.items():
            print(f"    CIN,{n}  {v}")

        print("\n=== TESTS ===")
        for slot, label, payload in TESTS:
            print(f"\n--- {label}")
            reply = send(fd, f"CIN,{slot},{payload}")
            sent = payload.split(",")
            got = read_slot(fd, slot)
            if got is None:
                print("    VERDICT: unreadable")
                continue
            if got[1] != FREQ:
                print(f"    VERDICT: WHOLE WRITE ABORTED (freq {got[1]}, reply {reply})")
                continue
            diffs = [f"field {i} sent {s!r} read {g!r}"
                     for i, (s, g) in enumerate(zip(sent, got)) if s != g]
            print("    VERDICT: " + ("every field kept" if not diffs
                                    else "write landed; differs: " + "; ".join(diffs)))
            if slot == 408:
                print(f"    CIN,401 now: {read_slot(fd, 401)}")

        print("\n=== RESTORE (401 last, so the firmware can move priority back) ===")
        for n in [s for s in SLOTS if s != 401] + [401]:
            send(fd, f"CIN,{n}," + ",".join(before[n]))

        print("\n=== VERIFY RESTORE ===")
        ok = True
        for n in SLOTS:
            now = read_slot(fd, n)
            match = now == before[n]
            ok &= match
            print(f"    CIN,{n}  {'MATCH' if match else 'MISMATCH ' + str(now) + ' vs ' + str(before[n])}")
        print("RESTORE " + ("OK" if ok else "INCOMPLETE -- see mismatches above"))
    finally:
        send(fd, "EPG")
        os.close(fd)
    return 0


sys.exit(main())
