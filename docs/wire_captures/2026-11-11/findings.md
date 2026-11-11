# BC75XLT: SCO and SCG writes (2026-11-11)

The dev BC75XLT, firmware `Version 1.02.04`, at 57600 through its CP210x
(`/dev/cu.usbserial-020D43D8`).

| Probe | Script | Capture |
|---|---|---|
| SCO / SCG write probe | [`bc75xlt-sco-scg-probe.py`](bc75xlt-sco-scg-probe.py) | [`bc75xlt-sco-scg-probe.txt`](bc75xlt-sco-scg-probe.txt) |

Every write was read back, then restored, and the restore was confirmed in a
fresh `PRG` bracket after `EPG` (`ALL RESTORED`).

## Why

A survey of public Uniden code found two claims that contradict Bearpaw's
facts about this radio:

1. **SCO.** [fruzyna/bearcat](https://github.com/fruzyna/bearcat)
   (MPL-2.0) writes `SCO,<0|1>,,<dir>` to a BC75XLT in a hardware test and
   asserts the read-back (`tests/test_bc75xlt.py:103-108`). Bearpaw sets
   `has_search_options: false` on the BC75XLT because every write was refused
   (#638, 2026-09-02). Every write tried then was the BC125AT's 2-field shape,
   `SCO,<delay>,<code>`. The radio's own reply has three fields
   (`SCO,1,,0`, [`2026-08-26/bc75xlt-compatibility.md`](../2026-08-26/bc75xlt-compatibility.md)),
   the same shape the SR30C accepts
   ([`2026-11-10/sr30c-findings.md`](../2026-11-10/sr30c-findings.md)).
2. **SCG.** The same test says "one group will always be true", suggesting the
   firmware refuses or rewrites an all-disabled bank mask. An SR30C stores one.

## Results

| Command | Sent | Reply | Read back | Result |
|---|---|---|---|---|
| `SCO` (outside `PRG`) | read | `SCO,NG` | — | program mode only, as on the SR30C |
| `SCG` (outside `PRG`) | read | `SCG,NG` | — | program mode only |
| `SCO` | `SCO,1,0` (2-field) | `SCO,ERR` | `SCO,0,,0` | **refused**: reproduces #638 |
| `SCO` | `SCO,0,,0` | `SCO,OK` | `SCO,0,,0` | stored |
| `SCO` | `SCO,1,,1` | `SCO,OK` | `SCO,1,,1` | **stored**: delay and direction both change |
| `SCO` | `SCO,2,,0` | `SCO,OK` | `SCO,1,,0` | **stored as 1**: a delay of 2 is OK'd and clamped |
| `SCG` | `SCG,1111111110` | `SCG,OK` | `SCG,1111111110` | stored |
| `SCG` | `SCG,1111111111` | `SCG,OK` | `SCG,1111111111` | **stored**: all banks disabled is accepted |

## What this changes

- **The BC75XLT accepts search options. It was refused because of the wrong
  shape, not because the radio lacks the setting.** It takes the SR30C's
  3-field form, `SCO,<delay 0/1>,,<direction>`, with the middle field (code
  search) reserved and sent empty. So `has_search_options` and
  `has_search_direction` should be `true` on the BC75XLT, matching the SR30C,
  with `has_search_code` staying `false`. CLAUDE.md's capability table
  ("`SCO` writes rejected, incl. a write of the value it just reported") is
  wrong: the "value it just reported" was re-sent in the 2-field shape.
- **A delay of 2 differs between the two radios.** The SR30C OKs a 2 and leaves
  the stored value alone. This BC75XLT OKs it and stores 1. Neither stores 2,
  and on both `OK` doesn't prove the value written, so validate `0/1` before
  the wire and verify by read-back, as the SR30C path already does.
- **An all-disabled `SCG` is stored on the BC75XLT too.** CLAUDE.md pitfall #7
  already says not to cite "the scanner refuses it". This adds the second
  model. fruzyna's claim may hold on its firmware (`1.01.02`); it does not on
  `1.02.04`.

## Starting state

`SCO` read `SCO,0,,0` at the start of this probe, where the 2026-08-26 probe
read `SCO,1,,0`. The radio has been used and reprogrammed in between, so the
earlier value is not expected to persist. The `<echo>` write therefore repeated
`SCO,0,,0`.
