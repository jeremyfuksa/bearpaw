#!/usr/bin/env python3
"""A fake Uniden scanner on a virtual serial port, for demos and screen recordings.

Opens a pseudo-terminal, links it at --link, and answers the scanner's line
protocol from an in-memory radio: channel memory, settings, PRG/EPG, and a
scan loop that "hits" a channel every few seconds. Busier channels hit more
often. Hits come from a seeded RNG, so the same --seed replays the same
session. Wire shapes are copied from docs/wire_captures/. Send SIGUSR1 to
swap scanners: the port disappears, and a few seconds later the other model
appears on it. Send SIGUSR2 to freeze the scan where it is (a hit stays open)
and again to resume, e.g. to hold a hit through a slow camera move.

--seed-history DB instead writes a week of past hits into an analytics
database, so the Scan view's charts have history to show. Run it while the
backend is stopped; the backend reads hits only at startup.

Normally started by demo.sh, which also builds the pty shim. Standard library only.
"""

import argparse
import math
import os
import random
import signal
import sqlite3
import sys
import time
import tty

MODELS = {
    "BC125AT": {
        "version": "Version 1.06.06",
        "channels": 500,
        "per_bank": 50,
        "cleared_delay": 2,
        "programmed_delay": 2,
        "absent": set(),
    },
    "BC75XLT": {
        "version": "Version 1.02.04",
        "channels": 300,
        "per_bank": 30,
        "cleared_delay": 0,
        "programmed_delay": 1,
        # Commands this model answers ERR, per
        # docs/wire_captures/2026-08-26/bc75xlt-compatibility.md.
        "absent": {"BLT", "BSV", "CNT", "WXS", "SSG", "DCH"},
    },
}

# (bank, alpha tag, MHz, modulation, CTCSS code or 0, weight). Codes: 72=88.5 Hz,
# 76=100.0, 82=123.0, 88=151.4 (see crates/bearpaw-api/src/protocol/tones.rs).
# Weight is how often the channel hits relative to the others. A BC75XLT has
# no tags, tones or per-channel modulation, so it ignores those fields.
PROGRAMMED = [
    (1, "North Hill Rptr", 146.760, "FM", 88, 9),
    (1, "Downtown Rptr", 147.255, "FM", 82, 4),
    (1, "2m Calling Freq", 146.520, "FM", 0, 1),
    (1, "70cm Link Rptr", 444.375, "FM", 76, 3),
    (1, "Tues Club Net", 145.290, "FM", 88, 2),
    (2, "Tower", 128.725, "AM", 0, 12),
    (2, "Ground", 121.900, "AM", 0, 8),
    (2, "Approach", 119.000, "AM", 0, 6),
    (2, "ATIS", 128.375, "AM", 0, 2),
    (2, "Unicom", 122.800, "AM", 0, 2),
    (2, "Air Guard", 121.500, "AM", 0, 1),
    (3, "NOAA Weather 2", 162.400, "FM", 0, 2),
    (3, "NOAA Weather 3", 162.475, "FM", 0, 1),
    (3, "NOAA Weather 1", 162.550, "FM", 0, 1),
    (4, "Railroad Main", 160.920, "NFM", 0, 7),
    (4, "Railroad Yard", 161.250, "NFM", 0, 5),
    (4, "Train Dispatch", 160.530, "NFM", 0, 3),
    (5, "GMRS Ch 1", 462.5625, "NFM", 0, 2),
    (5, "GMRS Ch 3", 462.6125, "NFM", 0, 1),
    (5, "GMRS 15 Repeater", 462.5500, "NFM", 72, 3),
    (5, "MURS Ch 1", 151.820, "NFM", 0, 1),
    (6, "Fire Dispatch", 154.430, "FM", 0, 10),
    (6, "Fire Tac 2", 154.280, "FM", 0, 3),
    (6, "EMS Operations", 155.340, "FM", 0, 6),
    (7, "Stadium Ops", 464.500, "NFM", 0, 4),
    (7, "Mall Security", 463.325, "NFM", 0, 2),
]

SETTINGS = {
    "VOL": "9",
    "SQL": "2",
    "BLT": "AF",
    "BSV": "2",
    "KBP": "99,0",
    "CNT": "8",
    "WXS": "0",
    "SCO": "2,0",
    "PRI": "0",
    "SCG": "0000000111",  # '1' = disabled: banks 1-7 on, 8-10 off
    "SSG": "1101111001",
    "CLC": "0,0,0,11111,0",
    "CSG": "1111111111",
    "BPL": "0",
}

# Relative traffic by hour of day: quiet overnight, busy at the commutes.
HOURLY = [1, 1, 1, 1, 1, 2, 4, 7, 8, 6, 5, 5, 6, 5, 5, 6, 8, 9, 7, 5, 4, 3, 2, 1]


def wire_freq(mhz):
    return f"{round(mhz * 10000):08d}"


def live_modulation(mhz):
    """What GLG reports for a channel set to AUTO: the band's own mode."""
    return "AM" if 108.0 <= mhz < 137.0 else "NFM"


class Radio:
    def __init__(self, seed, model):
        self.rng = random.Random(seed)
        self.model = model
        self.spec = MODELS[model]
        self.settings = dict(SETTINGS)
        self.channels = {i: self.cleared() for i in range(1, self.spec["channels"] + 1)}
        self.weights = {}
        slots = {}
        for bank, tag, mhz, mod, tone, weight in PROGRAMMED:
            slots[bank] = slots.get(bank, 0) + 1
            index = (bank - 1) * self.spec["per_bank"] + slots[bank]
            self.channels[index] = self.programmed(tag, mhz, mod, tone)
            self.weights[index] = weight
        self.custom = {i: (25.0, 54.0) for i in range(1, 11)}
        self.program_mode = False
        self.holding = False
        self.current = self.scan_list()[0]
        self.hit_until = 0.0
        self.next_hit = time.monotonic() + 3.0
        self.frozen_at = None

    def toggle_freeze(self):
        now = time.monotonic()
        if self.frozen_at is None:
            self.frozen_at = now
            return
        # Resume with the same time left on the hit and until the next one.
        paused = now - self.frozen_at
        self.frozen_at = None
        if self.hit_until:
            self.hit_until += paused
        self.next_hit += paused

    def squelch_open(self):
        if self.frozen_at is not None:
            return self.hit_until > 0.0
        return self.hit_until > time.monotonic()

    def cleared(self):
        return {"tag": "", "freq": 0.0, "mod": "AUTO", "tone": 0,
                "delay": self.spec["cleared_delay"], "lockout": 1, "priority": 0}

    def programmed(self, tag, mhz, mod, tone):
        if self.model == "BC75XLT":
            tag, mod, tone = "", "AUTO", 0
        return {"tag": tag, "freq": mhz, "mod": mod, "tone": tone,
                "delay": self.spec["programmed_delay"], "lockout": 0, "priority": 0}

    def bank_of(self, index):
        return (index - 1) // self.spec["per_bank"]

    def scan_list(self):
        mask = self.settings["SCG"]
        live = [i for i, c in self.channels.items()
                if c["freq"] and not c["lockout"] and mask[self.bank_of(i)] == "0"]
        return sorted(live) or [1]

    def tick(self):
        """Advance the scan: cycle channels, open and close hits on schedule."""
        if self.frozen_at is not None:
            return self.squelch_open()
        now = time.monotonic()
        if now < self.hit_until:
            return True
        if self.hit_until:
            self.hit_until = 0.0
            self.next_hit = now + self.rng.uniform(3.0, 9.0)
        if now >= self.next_hit:
            if not self.holding:
                live = self.scan_list()
                self.current = self.rng.choices(
                    live, [self.weights.get(i, 1) for i in live])[0]
            self.hit_until = now + self.rng.uniform(3.0, 8.0)
            return True
        if not self.holding:
            live = self.scan_list()
            pos = live.index(self.current) if self.current in live else -1
            self.current = live[(pos + 1) % len(live)]
        return False

    def handle(self, line):
        cmd, _, rest = line.partition(",")
        args = rest.split(",") if rest else []
        # GLG is the poll's first command each tick, so it advances the scan.
        sql = int(self.tick() if cmd == "GLG" else self.squelch_open())
        ch = self.channels.get(self.current, self.cleared())
        mod = ch["mod"] if ch["mod"] != "AUTO" else live_modulation(ch["freq"])
        bc75 = self.model == "BC75XLT"

        if cmd in self.spec["absent"]:
            return "ERR"
        if cmd == "MDL":
            return f"MDL,{self.model}"
        if cmd == "VER":
            return f"VER,{self.spec['version']}"
        if cmd in ("PRG", "EPG"):
            self.program_mode = cmd == "PRG"
            return f"{cmd},OK"
        if cmd == "KEY":
            if args[:1] == ["H"]:
                self.holding = True
            elif args[:1] == ["S"]:
                self.holding = False
            return "KEY,OK"
        if cmd == "GLG":
            if bc75:  # Decimal MHz, no tag, no channel number.
                return f"GLG,{ch['freq']:.4f},{mod},,,,,,{sql},{1 - sql},,,"
            return (f"GLG,{wire_freq(ch['freq'])},{mod},,{ch['tone']},,,{ch['tag']},"
                    f"{sql},{1 - sql},,{self.current},")
        if cmd == "STS":
            if bc75:
                return f"STS,1, {ch['freq']:.4f}      ,,{sql},{1 - sql}"
            line2 = f"CH{self.current:03d}  {ch['freq']:8.4f}"
            return (f"STS,011000,              ,,{ch['tag']:<16},,{line2:<16},,"
                    f"            ,,                ,,123          ,,"
                    f"{sql},{1 - sql},0,0,,,{5 if sql else 0},,3")
        if cmd == "PWR":
            raw = self.rng.randint(380, 760) if sql else self.rng.randint(15, 60)
            return f"PWR,{raw},{wire_freq(ch['freq'])}"
        if cmd == "CIN":
            return self.cin(args)
        if cmd == "DCH":
            self.channels[int(args[0])] = self.cleared()
            return "DCH,OK"
        if cmd == "CSP":
            i = int(args[0])
            if len(args) > 1:
                self.custom[i] = (int(args[1]) / 10000, int(args[2]) / 10000)
                return "CSP,OK"
            lo, hi = self.custom[i]
            return f"CSP,{i},{wire_freq(lo)},{wire_freq(hi)}"
        if cmd == "SSP":
            return f"SSP,{args[0]},1,0"
        if cmd == "GLF":
            return "GLF,-1"
        if cmd in ("LOF", "ULF"):
            return f"{cmd},OK"
        if bc75 and cmd == "KBP" and not self.program_mode:
            return "KBP,NG"
        if bc75 and cmd == "SCO" and args:
            return "SCO,ERR"
        if cmd in self.settings:
            if args:
                self.settings[cmd] = rest
                return f"{cmd},OK"
            return f"{cmd},{self.settings[cmd]}"
        print(f"  unhandled: {line!r}", file=sys.stderr)
        return "ERR"

    def cin(self, args):
        i = int(args[0])
        bc75 = self.model == "BC75XLT"
        if i not in self.channels:
            return "CIN,ERR" if bc75 else "CIN,NG"
        c = self.channels[i]
        if len(args) == 1:
            if bc75:
                return (f"CIN,{i},,{wire_freq(c['freq'])},,,"
                        f"{c['delay']},{c['lockout']},{c['priority']}")
            return (f"CIN,{i},{c['tag']},{wire_freq(c['freq'])},{c['mod']},"
                    f"{c['tone']},{c['delay']},{c['lockout']},{c['priority']}")
        # Write: an empty field means "leave unchanged", as on the radio.
        tag, freq, mod, tone, delay, lockout, priority = (args[1:] + [""] * 7)[:7]
        if tag and not bc75:
            c["tag"] = tag.strip()
        if freq:
            c["freq"] = int(freq) / 10000
        for key, value in (("mod", mod), ("tone", tone), ("delay", delay),
                           ("lockout", lockout), ("priority", priority)):
            if value:
                c[key] = value if key == "mod" else int(value)
        if bc75 and priority == "1":
            # This firmware moves priority within a bank itself (hardware
            # 2026-08-28); Bearpaw relies on it and never clears the old one.
            for j, other in self.channels.items():
                if j != i and self.bank_of(j) == self.bank_of(i):
                    other["priority"] = 0
        return "CIN,OK"


def seed_history(db_path, model, days, seed):
    """Write `days` of past hits for `model` into an existing analytics DB."""
    if not os.path.exists(db_path):
        sys.exit(f"{db_path} does not exist; start the backend once to create it")
    radio = Radio(seed, model)
    rng = radio.rng
    db = sqlite3.connect(db_path)
    # Bearpaw files a hit's scanner_id as the model name, not the device's
    # scanner ID (seen in the live rows it writes for this fake, 2026-10-15).
    # Seeding twice would double the history.
    if db.execute("SELECT 1 FROM scan_hits WHERE scanner_id = ? LIMIT 1", (model,)).fetchone():
        print(f"{model} already has history in {db_path}; not seeding", file=sys.stderr)
        return
    live = [i for i, c in radio.channels.items() if c["freq"]]
    weights = [radio.weights[i] for i in live]
    now = time.time()
    hour_start = now - now % 3600
    rows = []
    for h in range(days * 24, 0, -1):
        start = hour_start - h * 3600
        busy = HOURLY[time.localtime(start).tm_hour]
        for _ in range(rng.randint(0, 2) + round(busy * rng.uniform(0.6, 1.4))):
            index = rng.choices(live, weights)[0]
            c = radio.channels[index]
            ts = start + rng.uniform(0, 3600)
            duration = rng.uniform(2.0, 12.0)
            mod = c["mod"] if c["mod"] != "AUTO" else live_modulation(c["freq"])
            # Live BC75XLT hits carry neither: its GLG has no channel or tag.
            channel = None if model == "BC75XLT" else index
            rows.append((ts, c["freq"], channel, c["tag"] or None, mod,
                         rng.randint(35, 75), duration, "SCAN", None,
                         f"session-demo-{math.floor(ts / 86400)}", ts + duration, model))
    db.executemany(
        "INSERT INTO scan_hits (timestamp, frequency, channel, alpha_tag, modulation, rssi,"
        " duration, mode, bank, session_id, ended_at, scanner_id)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.commit()
    print(f"seeded {len(rows)} hits over {days} days for {model}", file=sys.stderr)


class Swap(Exception):
    pass


def serve(link, model, seed, quiet):
    """Serve until Ctrl-C. SIGUSR1 unplugs this model and plugs in the other;
    SIGUSR2 freezes or resumes the scan."""
    radio = None

    def swap(*_):
        raise Swap

    def freeze(*_):
        if radio:
            radio.toggle_freeze()

    signal.signal(signal.SIGUSR1, swap)
    signal.signal(signal.SIGUSR2, freeze)
    while True:
        master, slave = os.openpty()
        tty.setraw(slave)  # Bearpaw sets raw mode too; this covers the gap before it opens.
        # The slave stays open in this process, so the master never reads EIO
        # when Bearpaw closes and reopens the port.
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(os.ttyname(slave), link)
        print(f"fake {model} on {os.ttyname(slave)} -> {link} (pid {os.getpid()})",
              file=sys.stderr)
        radio = Radio(seed, model)
        buf = b""
        try:
            while True:
                buf += os.read(master, 1024)
                while b"\r" in buf:
                    raw, buf = buf.split(b"\r", 1)
                    line = raw.decode("ascii", "replace").strip()
                    if not line:
                        continue
                    reply = radio.handle(line)
                    if not quiet and line not in ("GLG", "STS", "PWR"):
                        print(f"==> {line}\n<== {reply}", file=sys.stderr)
                    os.write(master, reply.encode("ascii") + b"\r")
        except Swap:
            model = next(m for m in MODELS if m != model)
            print(f"unplugged; plugging in a {model}", file=sys.stderr)
        except KeyboardInterrupt:
            return
        finally:
            os.remove(link)
            os.close(master)
            os.close(slave)
        # Long enough for Bearpaw to notice the scanner is gone. A second
        # swap while unplugged is ignored rather than raised outside the try.
        signal.signal(signal.SIGUSR1, signal.SIG_IGN)
        time.sleep(3)
        signal.signal(signal.SIGUSR1, swap)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--link", default="/tmp/bearpaw-demo/scanner")
    parser.add_argument("--model", choices=sorted(MODELS), default="BC125AT")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--quiet", action="store_true", help="don't log traffic")
    parser.add_argument("--seed-history", metavar="DB",
                        help="write past hits into this analytics DB and exit")
    parser.add_argument("--days", type=int, default=7, help="history to seed")
    opts = parser.parse_args()
    if opts.seed_history:
        seed_history(opts.seed_history, opts.model, opts.days, opts.seed)
    else:
        serve(opts.link, opts.model, opts.seed, opts.quiet)


if __name__ == "__main__":
    main()
