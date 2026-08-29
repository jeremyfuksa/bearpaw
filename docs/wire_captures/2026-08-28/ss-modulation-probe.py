#!/usr/bin/env python3
"""
Export-fidelity probe: does a .bc125at_ss round-trip through Uniden's BC125AT SS
preserve per-channel MODULATION and TONE, or silently flatten them?

WHY THIS IS NEEDED
  The 2026-08-28 round-trip (bearpaw-export-125 -> BC125AT SS -> more-lockouts)
  showed Bearpaw writes `AUTO` where Uniden writes `Auto`. The tool accepted
  ours, but EVERY channel on the dev unit is AUTO, so the round-trip cannot
  distinguish "parsed our value and re-cased it" from "failed to parse and
  defaulted everything to Auto". Both produce identical output on uniform data.
  A field-mapping question needs a row that DISAGREES with its neighbours.

  Same argument for tone: every channel reads tone_squelch_kind=none today.

WHERE IT WRITES
  Bank 9 (channels 401-450) is the designated scratch bank on any Bearpaw
  scanner. This probe writes ONLY to slots that are already EMPTY (428-430),
  so nothing programmed is destroyed and "restore" is just clearing them back.
  Run with --restore to clear them.

  It never sends CLR.

RE-RUNNING
  The probe refuses to write a slot that is already programmed, so a second run
  aborts by design. Run with --restore first, which clears 428-430 back to
  empty, then run again.

GOTCHA
  `tone_dcs_code` is the RAW PROTOCOL CODE (128-231), not the Motorola number.
  DCS 023 is 128. Passing 23 is rejected with `tone_invalid`.
  `bank` is required on the PUT body: ChannelData has no serde default for it,
  and omitting it fails with 422 before any validation message you can read.
"""
import json, sys, urllib.request

BASE = "http://127.0.0.1:8000/api/v1"
SLOTS = [428, 429, 430]

# Deliberately three DIFFERENT modulations, none of them AUTO, plus one CTCSS
# and one DCS. If the tool flattens, these are the rows that show it.
TARGETS = {
    428: dict(frequency=154.0000, modulation="FM",  alpha_tag="PROBE FM",
              delay=2, lockout=False, priority=False, tone_squelch_kind="none", bank=9),
    429: dict(frequency=123.0000, modulation="AM",  alpha_tag="PROBE AM CTCSS",
              delay=2, lockout=False, priority=False,
              tone_squelch_kind="ctcss", tone_squelch=100.0, bank=9),
    430: dict(frequency=462.5625, modulation="NFM", alpha_tag="PROBE NFM DCS",
              delay=2, lockout=False, priority=False,
              tone_squelch_kind="dcs", tone_dcs_code=128, bank=9),
}

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=60) as resp:
        raw = resp.read().decode()
    return json.loads(raw) if raw.strip() else None

def get_channel(i):
    return req("GET", f"/memory/channels/{i}")

def show(label, ch):
    print(f"  {label:10} ch{ch['index']:>3}  {ch['frequency']:>10}  "
          f"mod={ch['modulation']:<5} tag={ch['alpha_tag']!r:<18} "
          f"tone={ch.get('tone_squelch_kind')}"
          f"{'/' + str(ch.get('tone_squelch')) if ch.get('tone_squelch') else ''}"
          f"{'/DCS' + str(ch.get('tone_dcs_code')) if ch.get('tone_dcs_code') else ''}")

restore = "--restore" in sys.argv

print("=== BEFORE ===")
before = {}
for i in SLOTS:
    before[i] = get_channel(i)
    show("before", before[i])

if restore:
    print("\n=== RESTORE: clearing probe slots back to empty ===")
    for i in SLOTS:
        req("PUT", f"/memory/channels/{i}",
            dict(frequency=0.0, modulation="AUTO", alpha_tag="", delay=2,
                 lockout=True, priority=False, tone_squelch_kind="none", bank=9))
        show("cleared", get_channel(i))
    sys.exit(0)

# Refuse to overwrite anything programmed. The empties were chosen deliberately.
for i in SLOTS:
    if before[i]["frequency"]:
        sys.exit(f"ABORT: ch{i} is programmed ({before[i]['frequency']}). "
                 "This probe only writes slots that are already empty.")

print("\n=== WRITE ===")
for i in SLOTS:
    req("PUT", f"/memory/channels/{i}", TARGETS[i])
    print(f"  wrote ch{i}")

print("\n=== READ BACK (from the radio) ===")
ok = True
for i in SLOTS:
    got = get_channel(i)
    show("readback", got)
    want = TARGETS[i]
    for field in ("modulation", "alpha_tag", "tone_squelch_kind"):
        if str(got.get(field)) != str(want[field]):
            print(f"    MISMATCH {field}: wrote {want[field]!r}, radio says {got.get(field)!r}")
            ok = False
    if abs(got["frequency"] - want["frequency"]) > 1e-6:
        print(f"    MISMATCH frequency: wrote {want['frequency']}, radio says {got['frequency']}")
        ok = False
print("\nreadback:", "ALL MATCH" if ok else "MISMATCHES ABOVE")
