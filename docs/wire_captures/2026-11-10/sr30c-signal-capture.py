#!/usr/bin/env python3
"""Log an SR30C's raw PWR against squelch and frequency (#880).

The SR30C's STS is the BC75XLT's short frame with no SIG_LVL, so Bearpaw's
bars come from PWR, which needs a per-band floor and top
(`ScannerCapabilities::pwr_bands`, measured for the BC75XLT in findings.md).
This records the same two things for the SR30C, per band:

  floor -> squelch OPEN on an empty frequency: --heard noise
  top   -> a clear transmission:               --heard clear (or a live net,
                                               tagged --heard net, where the
                                               strong stations give the top)

No BC125AT bars: findings.md showed they track signal strength too poorly
to calibrate against.

READ-ONLY: only MDL, GLG and PWR are sent. No PRG, no writes. stdlib only.
Appends to a CSV; Ctrl-C prints a per-label summary.

  python3 sr30c-signal-capture.py --label "net 146.790" --heard net
  python3 sr30c-signal-capture.py --summary
"""
import argparse, csv, glob, os, select, statistics, sys, termios, time

FIELDS = ["t", "label", "heard", "freq", "sql", "pwr"]


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


def send(fd, cmd, timeout=1.0):
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, (cmd + "\r").encode("ascii"))
    deadline, buf = time.time() + timeout, b""
    while time.time() < deadline and b"\r" not in buf:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                buf += os.read(fd, 4096)
            except BlockingIOError:
                pass
    return buf.decode("ascii", errors="replace").strip().strip("\x00")


def pct(v, p):
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


def summarize(path):
    rows = list(csv.DictReader(open(path)))
    print(f"\n{len(rows)} samples in {path}.")
    print(f"{'label':<26} {'heard':<6} {'freq':>9} {'sql':>4} {'n':>5} "
          f"{'min':>5} {'p10':>5} {'med':>5} {'p90':>5} {'max':>5}")
    keys = dict.fromkeys((r["label"], r["heard"], r["freq"], r["sql"]) for r in rows if r["pwr"])
    for label, heard, freq, sql in keys:
        v = sorted(int(r["pwr"]) for r in rows
                   if (r["label"], r["heard"], r["freq"], r["sql"]) == (label, heard, freq, sql) and r["pwr"])
        print(f"{label:<26} {heard:<6} {float(freq):9.4f} {sql:>4} {len(v):>5} "
              f"{v[0]:>5} {pct(v, 10):>5} {statistics.median(v):>5.0f} {pct(v, 90):>5} {v[-1]:>5}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", help="what you're tuned to, e.g. 'net 146.790'")
    ap.add_argument("--heard", choices=["noise", "weak", "clear", "net"],
                    help="noise = squelch open on an empty frequency; net = a live net")
    ap.add_argument("--port", help="SR30C serial node (default: the one /dev/cu.usbserial-*)")
    ap.add_argument("--out", default="sr30c-signal.csv")
    ap.add_argument("--interval", type=float, default=0.25)
    ap.add_argument("--summary", action="store_true")
    args = ap.parse_args()

    if args.summary:
        summarize(args.out)
        return 0
    if args.label is None or args.heard is None:
        ap.error("--label and --heard are required (unless --summary)")

    ports = [args.port] if args.port else glob.glob("/dev/cu.usbserial-*")
    if len(ports) != 1:
        sys.exit(f"Expected one serial node, found {ports}. Pass --port.")
    fd = open_port(ports[0])
    time.sleep(0.4)
    mdl = ""
    for _ in range(3):  # CLAUDE.md pitfall #11
        mdl = send(fd, "MDL")
        if mdl.startswith("MDL,"):
            break
    if mdl != "MDL,SR30C":
        sys.exit(f"{ports[0]} answered {mdl!r}, not MDL,SR30C")

    print(f"SR30C on {ports[0]}. Appending to {args.out} as {args.label!r} ({args.heard}).")
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
                raw = pwr[1] if len(pwr) >= 3 and pwr[0] == "PWR" else ""
                freq = int(pwr[2]) / 10000 if raw and pwr[2].isdigit() else 0.0
                sql = glg[8] if len(glg) > 9 and glg[0] == "GLG" else ""
                w.writerow(dict(t=f"{t0:.2f}", label=args.label, heard=args.heard,
                                freq=freq, sql=sql, pwr=raw))
                f.flush()
                print(f"{freq:9.4f} MHz  PWR {raw:>4}  sql={sql}", flush=True)
                time.sleep(max(0.0, args.interval - (time.time() - t0)))
        except KeyboardInterrupt:
            pass
    os.close(fd)
    summarize(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
