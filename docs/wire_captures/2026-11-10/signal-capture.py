#!/usr/bin/env python3
"""Pair a BC75XLT's raw PWR with a BC125AT's LCD bar count on the same signal (#815).

The BC75XLT has no signal meter on its LCD and its STS carries no SIG_LVL, so
there is no display to match. The BC125AT's bars are Uniden's calibration, so
we borrow them: both radios sit side by side on the same steady broadcast, you
read the bars off the BC125AT's LCD and pass them as --bars, and the script
logs the BC75XLT's PWR against that number.

  BC125AT -> read by eye. No cable needed; it is the same count as STS SIG_LVL.
  BC75XLT -> polled on its CP2104 serial node. READ-ONLY: only MDL, GLG and
             PWR are sent. No PRG, no writes, no settings changes.

stdlib only. Appends to a CSV so several stations accumulate into one file;
Ctrl-C prints a per-bar summary of everything in the file.

  python3 signal-capture.py --label "NOAA 162.550" --bars 4
"""
import argparse, csv, glob, os, select, statistics, sys, termios, time

FIELDS = ["t", "label", "a_bars", "x_freq", "x_sql", "x_pwr"]


def open_port(path, baud):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    speed = {57600: termios.B57600, 115200: termios.B115200}[baud]
    cc = list(attrs[6])
    cc[termios.VMIN] = 0
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW,
                      [0, 0, termios.CS8 | termios.CREAD | termios.CLOCAL, 0, speed, speed, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def send(fd, cmd, timeout=1.0):
    """One command, `\\r`-terminated, wait for the `\\r`-terminated reply."""
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, (cmd + "\r").encode("ascii"))
    deadline, buf = time.time() + timeout, b""
    while time.time() < deadline and b"\r" not in buf:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                buf += os.read(fd, 4096)
            except BlockingIOError:
                pass
    return buf.decode("ascii", errors="replace").strip()


def summarize(path):
    rows = list(csv.DictReader(open(path)))
    paired = [r for r in rows if r["x_pwr"]]
    print(f"\n{len(rows)} samples in {path}.")
    for label in dict.fromkeys(r["label"] for r in paired):
        v = sorted(int(r["x_pwr"]) for r in paired if r["label"] == label)
        bars = next(r["a_bars"] for r in paired if r["label"] == label)
        print(f"  {label:<24} bars={bars}  n={len(v):<4} PWR min={v[0]} median={statistics.median(v):.0f} max={v[-1]}")
    print("\nBC125AT bars -> BC75XLT PWR")
    print(f"{'bars':>4} {'n':>5} {'min':>5} {'p25':>5} {'med':>5} {'p75':>5} {'max':>5}")
    for bars in range(6):
        v = sorted(int(r["x_pwr"]) for r in paired if int(r["a_bars"]) == bars)
        if not v:
            print(f"{bars:>4} {0:>5}   (none)")
            continue
        q = statistics.quantiles(v, n=4) if len(v) > 1 else [v[0]] * 3
        print(f"{bars:>4} {len(v):>5} {v[0]:>5} {q[0]:>5.0f} {q[1]:>5.0f} {q[2]:>5.0f} {v[-1]:>5}")
    closed = sorted(int(r["x_pwr"]) for r in rows if r["x_sql"] == "0" and r["x_pwr"])
    if closed:
        print(f"\nBC75XLT squelch closed (any frequency): n={len(closed)} "
              f"min={closed[0]} median={statistics.median(closed):.0f} max={closed[-1]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", help="what you're tuned to, e.g. 'NOAA 162.550'")
    ap.add_argument("--bars", type=int, choices=range(6), help="bars on the BC125AT's LCD for this station")
    ap.add_argument("--port", help="BC75XLT serial node (default: the one /dev/cu.usbserial-*)")
    ap.add_argument("--baud", type=int, default=57600)
    ap.add_argument("--out", default="bc75xlt-vs-bc125at.csv")
    ap.add_argument("--interval", type=float, default=0.25, help="seconds between samples")
    ap.add_argument("--summary", action="store_true", help="print the summary of --out and exit")
    args = ap.parse_args()

    if args.summary:
        summarize(args.out)
        return 0

    if args.label is None or args.bars is None:
        ap.error("--label and --bars are required (unless --summary)")

    ports = [args.port] if args.port else glob.glob("/dev/cu.usbserial-*")
    if len(ports) != 1:
        sys.exit(f"Expected one BC75XLT serial node, found {ports}. Pass --port.")
    fd = open_port(ports[0], args.baud)
    time.sleep(0.4)
    # The CP210x often answers the first command after open with ERR
    # (CLAUDE.md pitfall #11), so MDL gets a few tries.
    mdl = ""
    for _ in range(3):
        mdl = send(fd, "MDL")
        if mdl.startswith("MDL,"):
            break
    if mdl != "MDL,BC75XLT":
        sys.exit(f"{ports[0]} answered {mdl!r}, not MDL,BC75XLT")

    print(f"BC75XLT on {ports[0]}; BC125AT LCD reads {args.bars} bars.")
    print(f"Appending to {args.out} as {args.label!r}. Ctrl-C to stop.")
    print("If the BC125AT's bars change, stop and rerun with the new --bars.\n")
    new = not os.path.exists(args.out)
    with open(args.out, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        try:
            while True:
                t0 = time.time()
                glg = send(fd, "GLG").split(",")
                pwr = send(fd, "PWR").split(",")
                # PWR,<raw>,<freq x 10000>; GLG field 8 is SQL (1 = open).
                x_pwr = pwr[1] if len(pwr) >= 3 and pwr[0] == "PWR" else ""
                x_freq = int(pwr[2]) / 10000 if x_pwr and pwr[2].isdigit() else 0.0
                x_sql = glg[8] if len(glg) > 9 and glg[0] == "GLG" else ""
                w.writerow(dict(t=f"{t0:.2f}", label=args.label, a_bars=args.bars,
                                x_freq=x_freq, x_sql=x_sql, x_pwr=x_pwr))
                f.flush()
                print(f"75XLT {x_freq:9.4f} MHz  PWR {x_pwr:>4}  sql={x_sql}")
                time.sleep(max(0.0, args.interval - (time.time() - t0)))
        except KeyboardInterrupt:
            pass
    os.close(fd)
    summarize(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
