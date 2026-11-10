#!/usr/bin/env python3
"""Write a full 500-channel image to the SR30C, slot for slot. WRITES MEMORY.

  sr30c-write-image.py <port> <image.json> <backup-out.json>

image.json: {"1": [name,freq,mod,tone,delay,lockout,pri], ... "500": [...]}
(the 7 CIN fields after the index, as strings). To undo a run, pass the backup
file as the image.

1. Reads all 500 slots and saves them to <backup-out.json>; refuses to write
   anything unless every slot read cleanly.
2. Writes each slot, then reads it back.
3. Reports slots whose freq/delay/lockout differ from the image. Priority is
   reported but not counted as a failure on an EMPTY slot: the firmware keeps
   one priority flag per bank and parks it on an empty slot itself.
Never sends CLR or DCH.
"""
import json, os, sys, time, termios, select


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


def send(fd, cmd, timeout=2.0):
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
    return buf.decode("ascii", errors="replace").strip("\r\x00")


def read_slot(fd, n):
    for _ in range(3):  # pitfall #11: a CP210x can garble a reply; retry reads only
        parts = send(fd, f"CIN,{n}").split(",")
        if len(parts) == 9 and parts[0] == "CIN" and parts[1] == str(n):
            return parts[2:]
    return None


def main():
    port, image_path, backup_path = sys.argv[1:4]
    image = {int(k): v for k, v in json.load(open(image_path)).items()}
    assert sorted(image) == list(range(1, 501)), "image must cover 1..500"

    fd = open_port(port)
    time.sleep(0.4)
    mdl = ""
    for _ in range(3):
        mdl = send(fd, "MDL")
        if mdl.startswith("MDL,"):
            break
    if mdl != "MDL,SR30C":
        print(f"REFUSING: expected MDL,SR30C, got {mdl!r}")
        return 1
    if send(fd, "PRG") != "PRG,OK":
        print("REFUSING: PRG not OK")
        return 1
    try:
        backup = {n: read_slot(fd, n) for n in range(1, 501)}
        bad = [n for n, v in backup.items() if v is None]
        if bad:
            print(f"REFUSING: could not back up slots {bad}")
            return 1
        json.dump({str(k): v for k, v in backup.items()}, open(backup_path, "w"), indent=0)
        print(f"backup: 500 slots -> {backup_path}", flush=True)

        problems, write_errs = [], []
        for n in range(1, 501):
            f = image[n]
            reply = send(fd, f"CIN,{n}," + ",".join(f))
            if reply != "CIN,OK":
                write_errs.append((n, reply))
            got = read_slot(fd, n)
            if got is None:
                problems.append((n, "unreadable after write", f, None))
                continue
            # compare freq, delay, lockout (fields 1, 4, 5)
            if [got[1], got[4], got[5]] != [f[1], f[4], f[5]]:
                problems.append((n, "differs", f, got))
            elif got[6] != f[6] and f[1] != "00000000":
                problems.append((n, "priority differs", f, got))
            if n % 50 == 0:
                print(f"  bank {n // 50} done", flush=True)

        print(f"\nwrite replies other than CIN,OK: {len(write_errs)}")
        for n, r in write_errs:
            print(f"  CIN,{n}: {r!r}")
        print(f"slots not matching the image: {len(problems)}")
        for n, why, want, got in problems:
            print(f"  CIN,{n}: {why}\n      wanted {want}\n      got    {got}")
    finally:
        print("EPG ->", send(fd, "EPG"))
        os.close(fd)
    return 0


sys.exit(main())
