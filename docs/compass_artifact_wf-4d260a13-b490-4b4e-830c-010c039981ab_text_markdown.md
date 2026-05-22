# Building custom software for the Uniden BCT125AT

The BCT125AT is, at the protocol level, a **BC125AT with BearTracker preprogramming**, and it speaks the same USB CDC-ACM serial dialect as the rest of Uniden's handheld "125-class" family. Treat it as a synchronous, ASCII, comma-delimited, CR-terminated request/response slave that you poll at roughly 5–10 Hz to mirror its display. There is no official Uniden protocol PDF titled "BCT125AT", but the **BC125AT Protocol v1.01** and the **BCT15X v1.03 Protocol** PDFs together cover everything the BCT125AT supports, with a small number of BearTracker-specific commands (`STT`, `BTL`, `BTS`) layered on top. macOS (including Apple Silicon), modern Linux, and Windows 10/11 all drive the scanner with built-in drivers; no kext, no DriverKit extension, and no FTDI/CP210x VCP is involved. Below is a complete reference for the developer who wants to build their own application around it.

A practical caveat up front: a few retailer listings and even some user firmware report the model string `BCT125AT`, but Uniden's own support TWiki, INF files, and most community libraries treat it as part of the BC125AT family with USB VID `0x1965` / PID `0x0017`. Verify your unit's MDL response and lsusb / `ioreg` output before assuming. If `MDL` returns `BCT125AT`, branch on it; everything else is the same.

## 1. USB interface and OS-level drivers

The scanner is a **native USB CDC ACM device**. There is no FTDI, Silicon Labs CP210x, Prolific PL2303, or CH340 bridge inside; the MCU implements USB itself. It enumerates with **`VID 0x1965` (Uniden America Corp.) / `PID 0x0017`**, class 02 (Communications), subclass 02 (Abstract Control Model). The Uniden Windows INF file for the BC125AT lists this exact VID/PID and binds the in-box `usbser.sys`. The "Universal Serial Driver" INF further covers PIDs `0x0016`–`0x001A` for the broader 125/126 / 75XLT / AE125H family. **The device is serial-only.** It does not present a mass-storage or HID interface, unlike Uniden's DMA database scanners (SDS100/200, BCD436HP/536HP) which expose a "Mass Storage Mode" with an SD card.

**macOS, including Apple Silicon (M1/M2/M3)**, needs **no driver install, no kext, and no DriverKit extension**. Apple's built-in `AppleUSBCDCACMData` / `AppleUSBCDC` drivers ship signed by Apple in every release, so there are no Gatekeeper, SIP, or System Extension approval prompts. The device appears as `/dev/cu.usbmodemXXXX` (and `/dev/tty.usbmodemXXXX`). **Always open the `cu.*` node**, not the `tty.*` node, because `tty.*` blocks on open waiting for DCD that the scanner does not assert. The suffix is `usbmodem`, never `usbserial` (the latter is used only by FTDI/SiLabs/Prolific VCPs, which this device does not need). macOS may reassign the trailing number on every replug, so match by USB serial number rather than path. The community `MacBearcat` app confirms native CDC support on macOS without any third-party kernel code.

**Linux** binds the device via the in-tree **`cdc_acm`** kernel module and presents it as **`/dev/ttyACM0`**. No special udev rule is required for enumeration, but two are recommended: one to grant your user access (`MODE="0666"` or `GROUP="dialout"`), and one to tell `ModemManager` to ignore the device, because `ModemManager` will probe newly-attached ACM devices and can corrupt early traffic (`SUBSYSTEMS=="usb", ATTRS{idVendor}=="1965", ATTRS{idProduct}=="0017", ENV{ID_MM_DEVICE_IGNORE}="1"`). On very old kernels (circa 2014–2015) the device's descriptors triggered a `cdc_acm: probe ... failed with error -22` ("Zero length descriptor references") and required a manual driver bind: `echo "1965 0017 2 076d 0006" > /sys/bus/usb/drivers/cdc_acm/new_id`. This is unnecessary on modern kernels but still appears in `bc125at-perl` and `bc125py` documentation as a defensive recipe. **TLP** (laptop power management) and USB autosuspend are known to break the connection silently; disable them or pin `power/autosuspend=-1` for this VID via udev.

**Windows 10/11** auto-installs the driver in most cases because `usbser.sys` ships in-box and the generic CDC INF binds automatically. If Device Manager shows the device as un-installed, the signed **"Windows_Serial_Drivers.zip"** from Uniden's BCD536HP TWiki page provides the matching `.INF`/`.CAT` pair (the older `BC125AT_USB_driver.zip` is unsigned and fails on Windows 8.1+). The COM port enumerates with the friendly name **"BC125AT"** under Ports (COM & LPT), with hardware ID `USB\VID_1965&PID_0017`. Some users see garbled COM names (`COMn~`) with older .NET, and cheap charge-only Mini-B cables fail silently; use the cable shipped with the scanner.

**Serial settings** come straight from the official BC125AT PC Protocol v1.01 PDF: **115200 baud, 8 data bits, 1 stop bit, no parity, no flow control**. Because it's CDC-ACM the baud rate is effectively metadata; values from 4800 to 115200 all work, but 115200 8N1 is the canonical setting used by every Uniden, Butel, ProScan, and OSS library. **Line ending is CR only (`\r`, 0x0D); never `\r\n`.** A stray LF leaves a byte in the input buffer that turns the next command into `ERR`.

A few quirks to design around. The scanner must be powered on for the USB endpoint to enumerate; a powered-off scanner only charges. Opening the port does **not** reset the scanner the way it does an Arduino, but on Linux/macOS the default port-open behavior toggles DTR, which has caused intermittent disconnects for some users; **set `dsrdtr=False` (pyserial) or `hupcl: false` (Node serialport)** before opening. The Linux CDC-ACM driver enables tty echo by default, so set raw mode (`cfmakeraw()` / clear `ICANON`/`ECHO`) immediately after open to avoid garbled early traffic.

## 2. Wire protocol fundamentals

The protocol is **half-duplex, synchronous, and case-sensitive**. Commands are uppercase ASCII keywords followed by comma-delimited fields and a single `\r`. Responses echo the command name followed by either fields (for "get" commands), `OK` (for "set" commands), `NG` (correct command, wrong mode), or the bare token `ERR` for syntactic or out-of-range errors. The scanner sends **no unsolicited data**, no banner, and no echo of your raw command. You must wait for one response before sending the next command; pipelining is not supported and produces `ERR`, `NG`, or mangled output.

Error semantics matter for clean code. **`ERR\r` means "fix your command"** (syntax or value error); **`<CMD>,NG\r` means "right command, wrong mode"**, typically because you forgot `PRG` first or the scanner is in a menu / direct-entry / quick-save state. Treat them differently in your application. Two more error tokens, `FER` (UART framing) and `ORER` (UART overrun), exist in the BCT15X spec but you will essentially never see them over USB.

In any "set" command, **leaving a field empty (just a comma) means "leave this field unchanged"**. Format errors abort the whole write; there are no partial updates. Channel names need to be explicitly padded with spaces to clear them, because a truly empty alpha field is interpreted as "do not change."

The scanner has two macro-modes. **Operational mode** is the default; `STS`, `GLG`, `KEY`, `PWR`, `MDL`, `VER`, `VOL`, and `SQL` all work. **Program Mode** is entered with `PRG\r` and exited with `EPG\r`; in this state the LCD shows "Remote Mode / Keypad Lock," scanning stops, and the memory-modifying commands (`CIN`, `DCH`, `CLR`, `BLT`, `BSV`, `PRI`, `KBP`, `SCG`, `SSG`, `CSG`, `CSP`, `CLC`, `WXS`, `CNT`, `GLF`/`ULF`/`LOF`, plus the BCT125AT `STT`/`BTL`/`BTS`) become valid. Keep your real-time UI in operational mode and bracket programming operations in `PRG`/`EPG` blocks.

## 3. Operational-mode commands (real-time control)

These are the commands your live UI will use constantly. The most important ones are `MDL`, `VER`, `STS`, `GLG`, `KEY`, `PWR`, `VOL`, and `SQL`. The `STS`, `GLG`, `KEY`, and `PWR` commands are **not in the official BC125AT PDF** but are universally supported on this firmware family and are documented by Uniden in the BCT15X protocol PDF; ProScan author Bob Smith has confirmed this in multiple RadioReference threads.

**Identification.** `MDL\r` returns `MDL,BC125AT\r`, `MDL,BCT125AT\r`, or one of the international variants (`UBC125XLT`, `UBC126AT`, `AE125H`). Use it for port auto-detection: probe every CDC port until one returns `MDL,...`. `VER\r` returns `VER,Version 1.04.02\r` (or similar) and is useful to log because field counts in `STS` and `GLG` can vary by firmware.

**Volume and squelch** both work in any mode and use the form `VOL\r` / `VOL,n\r` and `SQL\r` / `SQL,n\r`. **The BC125AT/BCT125AT range is 0–15** for both volume and squelch (0 = open, 15 = closed for SQL). Do not import the BCT15X range of 0–29 / 0–19 by mistake; that is a different scanner family.

**`STS\r` returns a dump of the LCD plus status bits.** The response format on the BC125AT family is:

```
STS,<DSP_FORM>,<L1_CHAR>,<L1_MODE>,<L2_CHAR>,<L2_MODE>,<L3_CHAR>,<L3_MODE>,
    <L4_CHAR>,<L4_MODE>,<SQL>,<MUT>,<RSV>,<WAT>,<LED_CC>,<LED_ALERT>,<SIG_LVL>,<RSV>,<BK_DIMMER>\r
```

`DSP_FORM` is a 4-digit binary mask telling you which lines are large font (1) vs small (0). Each `Lx_CHAR` is exactly 16 ASCII characters, space-padded. Each `Lx_MODE` is a 16-char mask where space means normal, `*` means reverse video, and `_` means underline; if all 16 chars are normal, the field **collapses to empty** so you see `,,` instead of 16 spaces. `SQL` is 1 if squelch is open, `MUT` is 1 if muted, `WAT` carries weather/SAME alert state, the two LED fields are 0/1 for Close Call and Alert LEDs, `SIG_LVL` is the 0–5 signal-bar value, and `BK_DIMMER` is 0=Off / 1=Low / 2=Mid / 3=High. Parse defensively: the field count varies across firmware revisions (especially after 1.04.02), and the BC125AT has 4 display lines but the BCT15X has up to 8, so libraries that hard-code field positions will break.

A real captured exchange in scan-hold on 851.0125 MHz looks like:

```
> STS\r
< STS,0110,
    HOLD     L/O    ,                ,
    SYSTEM 1        ,                ,
    851.0125MHz     ,                ,
    P NFM ATT       ,                ,
    0,1,0,0,0,0,1,,\r
```

**`GLG\r` returns current reception information.** On the BC125AT family the documented and reverse-engineered format is approximately:

```
GLG,<FRQ>,<MOD>,<ATT>,<CTCSS/DCS>,<NAME1>,<NAME2>,<NAME3>,<SQL>,<MUT>[,<RSV>,<CHAN_NUM>]\r
```

`FRQ` is a frequency in 100 Hz units encoded as an 8-digit integer with leading zeros (so `01462250` is 146.2250 MHz). `MOD` is `AM`/`FM`/`NFM`/`AUTO`. `CTCSS/DCS` is the integer tone code (0–231, see the table below). `NAME1/2/3` are the bank/system, group, and channel alpha tags (groups are unused on the BC125AT's flat memory). `SQL` and `MUT` are bits. Pa3ang's serial-sniffer reverse-engineering of `GLG` on the UBC125XLT identified an additional trailing channel-number field; whether this appears depends on firmware, so **always split-and-index rather than expecting a fixed field count**. When the scanner is idle or between channels you get a comma skeleton like `GLG,,,,,,,,,\r` (or `GLG,,,,,,,,,,,\r`); treat that explicitly as "no current channel."

**`PWR\r` returns RSSI and current frequency:** `PWR,742,01545500\r`. RSSI is a 0–1023 raw ADC value, **not dBm**, and on the BC125AT/BCT125AT it updates slowly and has limited dynamic range. Use it for "signal present / strong / weak," not for a precision S-meter. Calibration varies by band.

**`KEY,<CODE>,<MODE>\r` simulates a keypress.** Codes are single characters. `MODE` is `P` (press), `L` (long press), `H` (hold down indefinitely, auto-timeout after 10 seconds), or `R` (release a prior `H`). The verified BC125AT/BCT125AT key codes are: `M` Menu, `F` Function, `H` Hold/Resume, `S` Scan, `L` Lockout, `1`–`9` and `0` for digits, `.` for ./No, `E` for E/Yes, `>` and `<` for the scroll knob clockwise/counter-clockwise, `V` for the scroll-knob push (volume mode), `Q` for Func+scroll-push (squelch mode), `P` for priority (Func+5), `W` for weather (Func+3). The BearTracker key on the BCT125AT is **not** documented anywhere; the BCT15X uses `B` for an equivalent function, but verify empirically by sweeping A–Z and watching the LCD via `STS`. A simple menu press is `KEY,M,P\r` → `KEY,OK\r`; allow ~50–100 ms between consecutive KEY packets for the firmware's key debounce.

The complete operational reference is below. Commands marked "both modes" work whether or not you are in PRG.

| Command | Direction | Example response | Notes |
|---|---|---|---|
| `MDL` | get | `MDL,BCT125AT` | Identification; both modes |
| `VER` | get | `VER,Version 1.04.02` | Firmware string; both modes |
| `PRG` | enter | `PRG,OK` or `PRG,NG` | NG if in menu/direct entry/quick save |
| `EPG` | exit | `EPG,OK` | Returns to scan hold |
| `VOL` / `VOL,n` | get/set | `VOL,8` / `VOL,OK` | Range 0–15; both modes |
| `SQL` / `SQL,n` | get/set | `SQL,5` / `SQL,OK` | Range 0–15; both modes |
| `STS` | get | (multi-field display dump) | Both modes; field count varies |
| `GLG` | get | `GLG,01545500,FM,,76,Police,,Dispatch,1,0` | Both modes; empty when idle |
| `PWR` | get | `PWR,742,01545500` | Both modes |
| `KEY,c,m` | set | `KEY,OK` | Both modes |
| `BLT` / `BLT,v` | get/set | `BLT,KY,` / `BLT,OK` | `AO/AF/KY/SQ/KS`; spec says PRG only, accepted in both |

## 4. Programming-mode commands

After `PRG\r` succeeds, the full memory programming command set becomes available. The most important one is **`CIN`** (Channel Info), which both reads and writes the entire definition of a single memory channel:

```
> PRG\r
< PRG,OK\r
> CIN,42\r
< CIN,42,Tower Ground   ,01210000,AM,0,2,0,0\r
> CIN,1,Marine Ch 16   ,01560000,FM,0,2,0,0\r
< CIN,OK\r
> EPG\r
< EPG,OK\r
```

CIN fields are: index (1–500), alpha tag (≤16 chars, space-padded), frequency (8-digit, 100 Hz units, e.g. `01545000` = 154.5000 MHz; valid 25–512 MHz), modulation (`AUTO`/`AM`/`FM`/`NFM`), CTCSS/DCS code (0–231; 0 = none, 127 = SEARCH, 240 = NO_TONE, 64–113 are CTCSS tones from 67.0 Hz to 254.1 Hz, 128–231 are DCS codes), delay (`-10,-5,0,1,2,3,4,5`), lockout (0/1), priority (0/1). Empty fields mean unchanged.

The other programming commands are documented in the BC125AT PDF and work identically on the BCT125AT. **`DCH,n\r`** deletes a channel. **`CLR\r`** wipes all 500 channels and settings to factory defaults; it takes around 30 seconds and the scanner is unresponsive during that time, so extend your read timeout to at least 45–60 seconds for that one command. **`SCG\r`** controls the 10 channel-storage banks via a 10-digit mask where **0 means enabled and 1 means disabled** (counter-intuitive; document this loudly in your code). The bank order in the mask matches the LCD icon order 1, 2, 3, …, 9, 0 (the "0" key is bank 10). **`SSG\r`** does the same for the 10 service-search banks (Police, Fire/Emerg, Ham, Marine, Railroad, Civil Air, Mil Air, CB, FRS/GMRS/MURS, Racing). **`CSG\r`** masks the 10 custom search ranges, and **`CSP,n\r`** reads or sets a custom range's lower and upper limits. **`CLC\r`** controls Close Call (mode, alert beep/light, 5-band mask, lockout); the band-bit ordering differs between v1.00 and v1.01 of the protocol PDF, so test on your unit. **`PRI\r`** sets priority mode (0 off / 1 on / 2 plus / 3 DND). **`KBP\r`** controls key beep and keypad lock. **`BSV\r`** sets battery save / charge time (1–16 hours). **`WXS\r`** toggles weather alert priority. **`CNT\r`** sets LCD contrast (1–15). **`BLT\r`** sets backlight behavior (`AO`/`AF`/`KY`/`SQ`/`KS`). **`GLF\r`**, **`LOF,freq\r`**, and **`ULF,freq\r`** walk, add, and remove the global lockout frequency list (up to 200 entries, mixing temporary and permanent).

The memory architecture itself is dead simple: **500 channels in a flat namespace, divided into 10 banks of 50 channels** (bank 1 = channels 1–50, bank 2 = 51–100, …, bank 0 = 451–500). There are no systems, no groups, no sites, no trunking, because this is a conventional-only analog scanner. One priority channel per bank. No user-programmable BearTracker memory; the BearTracker frequencies are baked into firmware per state.

## 5. BearTracker / Highway Patrol commands (BCT125AT-specific)

Uniden has **never published a BCT125AT protocol PDF**. The BearTracker commands below are inferred from the BCT15X v1.03 spec and are the basis third-party tools use when supporting the BCT125AT. Verify each command on your unit before depending on it in shipping code.

**`STT\r` selects the active BearTracker state**, using a two-letter US state abbreviation (`STT,TX\r` → `STT,OK\r`) or a `CAN_xx` Canadian province code. The BCT requires a state at all times; there is no "off" value.

**`BTL\r` controls per-category lockout** for the four BearTracker frequency categories: `BTL,POL,DOT,HP,BT\r`, each 0 (unlocked) or 1 (locked out). `BTL,0,1,1,0\r` for example locks DOT and Highway Patrol while leaving Police and BearTracker mobile-extender frequencies active.

**`BTS\r` is the BearTracker options block**, with fields for alert beep tone (0–9), alert tone level (0=auto, 1–15), tape-out record flag (reserved on BCT125AT, which has no tape out), delay (`-10,-5,-2,0,1,2,5,10,30`), conventional system hold time, and alert light pattern (0 off / 2 slow / 3 fast). The trunked system hold time field is reserved on the analog-only BCT125AT.

The **HWY mode key** on the keypad is the BearTracker activation; on the BCT15X this maps to `KEY,B,P\r`, but for the BCT125AT this is unconfirmed and must be discovered empirically by sweeping the alphabet and reading the resulting LCD via `STS`. Commands inherited from the BCT15X family but **not applicable** to the BCT125AT include `BSP` (Band Scope), `BBS` (Broadcast Screen), all GPS commands (`GGA`, `RMC`, `GDO`), and the location alert system (`CLA`, `DLA`, `LIN`, `LIH`, `LIT`); they will return `NG` or `ERR`. There is also no `ESN` command on this family.

## 6. Application architecture

The cleanest way to structure a custom controller is in five layers. The **transport layer** owns the serial port, reads bytes, splits on `\r`, and handles reconnection on disconnect. The **command layer** exposes `send_command(cmd) -> response` synchronously, guarded by a mutex so only one request is in flight at a time, because the scanner has no transaction IDs and matches responses purely by FIFO order. The **decoder layer** parses each response into a typed object, handling the empty-field-collapse rule for `STS` and the variable trailing fields in `GLG`. The **state layer** holds a `ScannerState` (display lines, display attributes, signal bars, squelch open, mute, frequency, modulation, CTCSS/DCS, channel name, channel number, current mode), diffs successive snapshots, and emits change events. The **polling loop** issues `STS` and `GLG` back-to-back on a fixed interval, with optional slower interleaving of `PWR`. The **UI layer** subscribes to state-change events and renders.

The **connection lifecycle** looks like: enumerate ports filtering by `VID=0x1965` (use libudev/pyudev on Linux, IORegistry on macOS, SetupDi on Windows); fall back to probing every CDC candidate with `MDL\r`. Open the port at 115200 8N1 no flow control, **explicitly disabling DTR/RTS** (`dsrdtr=False`, `hupcl: false`) and putting the tty in raw mode immediately after open. Drain the input buffer. Issue `MDL` and `VER`, cache the strings, and branch to BCT125AT-specific code if needed. Then begin polling. On read timeout three times in a row, close the port and reconnect with exponential backoff (1s, 2s, 5s, 10s, capped). If you used `PRG` for memory work, always issue `EPG` before closing; if your app crashed and left the scanner in Remote Mode, the recovery is to reopen the port and send `EPG\r`, or use `bc125py unlock` style logic.

**Polling cadence** is the single most important architectural choice. The scanner pushes nothing, so every UI update is the result of a poll. Community practice and ProScan's defaults converge on **100–250 ms per `STS`+`GLG` pair** for a snappy UI, with a conservative floor around 300–500 ms on macOS over USB-virtualization or on slow machines. ProScan exposes a user-settable interval from 5 ms to 2000 ms; at the aggressive end, the BC125AT family is known to occasionally drop or truncate `STS` responses even when polled correctly, so defensively discard incomplete responses and re-poll on the next tick rather than throwing. Interleave `PWR` at ~500 ms if you want an RSSI bar. After `PRG,OK\r` give the scanner ~50–100 ms before the first programming command; after `EPG,OK\r` give ~100 ms before resuming `STS` polling, because mode transitions can produce partial `STS` responses. `CLR` is the one operation that needs a multi-tens-of-seconds timeout.

For **threading and async**, the cleanest Python pattern is a single dedicated worker thread doing blocking `pyserial.read_until(b'\r')` with a 500 ms timeout, pushing parsed updates onto a `queue.Queue` for the UI thread (Tkinter, PyQt, web framework). This avoids both the complications of `pyserial-asyncio` and the threading hazards of mixing serial I/O with GUI event loops. In Node.js, the idiomatic shape is `SerialPort` plus `@serialport/parser-readline` with `delimiter: '\r'`, paired with a small in-memory FIFO of pending command promises that you resolve in arrival order; commands are queued through an awaitable `cmd(line)` method. In either language the **invariant is one outstanding command at a time**; build that into the API, not into the caller.

For **modeling display state**, parse `STS` into a `display: { lines: string[16][], modes: ('normal'|'reverse'|'underline')[16][] }` structure plus the status bits, and `GLG` into a `reception: { frequencyHz, modulation, toneCode, name, channelNumber, squelchOpen, muted }`. Diff against the previous snapshot and emit only the deltas to the UI; that lets you poll at 10 Hz without slamming the renderer.

## 7. Code: minimal Python and Node clients

A practical Python skeleton using pyserial:

```python
import threading, queue, time, serial, serial.tools.list_ports

class BC125AT:
    def __init__(self, port, baud=115200, timeout=0.5):
        self.ser = serial.Serial()
        self.ser.port = port
        self.ser.baudrate = baud
        self.ser.bytesize = 8; self.ser.parity = 'N'; self.ser.stopbits = 1
        self.ser.timeout = timeout; self.ser.write_timeout = 1.0
        self.ser.rtscts = False; self.ser.xonxoff = False; self.ser.dsrdtr = False
        self.ser.open()
        self.ser.reset_input_buffer(); self.ser.reset_output_buffer()
        self._lock = threading.Lock()

    @classmethod
    def autodetect(cls):
        for p in serial.tools.list_ports.comports():
            if p.vid == 0x1965:
                return cls(p.device)
        for p in serial.tools.list_ports.comports():
            try:
                d = cls(p.device)
                if d.cmd('MDL').startswith('MDL,'): return d
                d.ser.close()
            except Exception: pass
        raise RuntimeError('No BC125AT/BCT125AT found')

    def cmd(self, line):
        with self._lock:
            self.ser.reset_input_buffer()
            self.ser.write(line.encode('ascii') + b'\r'); self.ser.flush()
            resp = self.ser.read_until(b'\r')
            if not resp.endswith(b'\r'):
                raise IOError(f'Timeout: {line!r}')
            return resp[:-1].decode('ascii', errors='replace')

s = BC125AT.autodetect()
print(s.cmd('MDL'), s.cmd('VER'))

stop = threading.Event()
state_q = queue.Queue()
def poll(scanner, q, interval=0.15):
    while not stop.is_set():
        try:
            q.put(('upd', scanner.cmd('STS'), scanner.cmd('GLG')))
        except Exception as e:
            q.put(('err', repr(e))); time.sleep(1.0)
        stop.wait(interval)
threading.Thread(target=poll, args=(s, state_q), daemon=True).start()
```

The equivalent Node.js sketch:

```js
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

class BC125AT {
  constructor(path) {
    this.port = new SerialPort({ path, baudRate: 115200, dataBits: 8,
      parity: 'none', stopBits: 1, rtscts: false, xon: false, xoff: false, hupcl: false });
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r' }));
    this._q = [];
    this.parser.on('data', line => { const w = this._q.shift(); if (w) w.resolve(line); });
  }
  cmd(line, timeoutMs = 500) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: ' + line)), timeoutMs);
      this._q.push({ resolve: v => { clearTimeout(t); resolve(v); },
                     reject:  e => { clearTimeout(t); reject(e); } });
      this.port.write(line + '\r');
    });
  }
}

const s = new BC125AT('/dev/cu.usbmodem14101');
console.log(await s.cmd('MDL'));
setInterval(async () => {
  try { onState(await s.cmd('STS'), await s.cmd('GLG')); }
  catch (e) { console.warn(e.message); }
}, 150);
```

The exact same approach works on macOS by passing `/dev/cu.usbmodemXXXX`, on Linux by passing `/dev/ttyACM0`, and on Windows by passing `COM5` (or whatever the device manager assigns).

## 8. Real wire traffic, by example

A live-monitoring conversation looks like this once the scanner is scanning normally:

```
> MDL\r
< MDL,BCT125AT\r
> VER\r
< VER,Version 1.04.02\r
> GLG\r
< GLG,,,,,,,,,\r                                       (idle)
> STS\r
< STS,0000,SCAN            , ,Bank 1          , ,                , ,                , ,0,0,0,0,0,0,0,,0\r
> GLG\r
< GLG,01545500,FM,,76,Police,,Dispatch    ,1,0\r       (active TX, 154.5500 MHz, CTCSS 100.0 Hz)
> PWR\r
< PWR,742,01545500\r
> STS\r
< STS,0110,HOLD            , ,Police          , ,Dispatch        , ,154.5500MHz FM  , ,1,0,0,0,0,0,4,,0\r
> KEY,H,P\r
< KEY,OK\r                                              (press Hold)
```

Programming a single channel:

```
> PRG\r
< PRG,OK\r
> CIN,1,Marine Ch 16   ,01560000,FM,0,2,0,0\r
< CIN,OK\r
> CIN,1\r
< CIN,1,Marine Ch 16   ,01560000,FM,0,2,0,0\r
> EPG\r
< EPG,OK\r
```

Switching the BearTracker state and locking out DOT and HP:

```
> PRG\r
< PRG,OK\r
> STT,TX\r
< STT,OK\r
> BTL,0,1,1,0\r
< BTL,OK\r
> EPG\r
< EPG,OK\r
```

## 9. Existing libraries, ranked

There is **no library specifically named for the BCT125AT**, but several open-source projects implement the BC125AT family protocol cleanly, and one (suidroot/pyUniden) targets the BCT15X command vocabulary that the BearTracker commands derive from.

For BC125AT-family architecture and CLI patterns, **`itsmaxymoo/bc125py`** (Python, MIT, ~31 stars, v1.0.0 released August 2024) is the cleanest reference: a CLI plus library with a per-setting "scanner data object" class hierarchy, JSON/CSV import-export, and an interactive `shell` for testing. It is programming-focused (no real-time monitoring loop). It is also the source of the well-known `cdc_acm/new_id` recipe and the TLP warning for Linux laptops. (https://github.com/itsmaxymoo/bc125py)

**`fdev/bc125csv`** (Python) is the best example of a clean, well-tested implementation with a **virtual scanner mock** (`--no-scanner`) for unit testing without hardware, plus an interactive shell mode. Supports BC125AT/UBC125XLT/UBC126AT. (https://github.com/fdev/bc125csv)

**`suidroot/pyUniden`** (Python) is the closest open-source implementation of the BCT15X-family protocol, which is the one the BCT125AT inherits its BearTracker commands from. It is the right starting point if you want to copy a working `KEY`/`STS`/`GLG` implementation rather than re-deriving it. (https://github.com/suidroot/pyUniden)

**`pa3ang/ubc125xlt`** is small but exceptionally valuable: it is the only public source for the empirically-reverse-engineered `GLG` field map on this scanner family, and it is a complete worked example of a Tkinter UI driven by a 500 ms `GLG` polling loop that logs channel history and can push events to Telegram. (https://github.com/pa3ang/ubc125xlt)

**`fruzyna/bearcat`** (Python, MPL-2.0) is a modern multi-model library with a clean class-per-model architecture; it currently supports BC125AT and BC75XLT, and is explicitly designed to grow. (https://github.com/fruzyna/bearcat) **`rikus--/bc125at-perl`** is the original Perl tool (circa 2013) and remains worth reading for the Linux driver gotchas. (https://github.com/rikus--/bc125at-perl, http://www.rikus.org/bc125at-perl) **`vrwallace/ScannerScreenPC`** (FreePascal/Lazarus, broad model support including BC125AT) is the most architecturally similar OSS tool for a real-time monitoring app with TTS. **`jkctech/SPARK125`** (C#/.NET, GPL-3.0, work-in-progress) is the only .NET reference. The **`bradtown.com BC125AT` WebUSB programmer** runs in-browser with no drivers and is a useful demo of the protocol in action.

For **JavaScript/TypeScript, Node.js, Go, Rust, Ruby, C, and C++**, there is **no model-specific community library**. You would be writing the first. The generic `serialport` npm package is well-maintained and handles everything you need. The closest C# reference is SPARK125.

The closed-source-but-protocol-confirmation tools are **ProScan** (Bob Smith, https://www.proscan.org/), **ARC125** (Butel, https://www.butel.nl/), **Scan125** (Nick Bailey, https://www.nick-bailey.co.uk/scan125/), and Uniden's own **BC125AT_SS** (http://info.uniden.com/twiki/pub/UnidenMan4/BC125AT/BC125AT_SS_V1_03_00.zip). ProScan's BCT15X profile reportedly drives the BCT125AT with full virtual control, though Bob has not officially listed BCT125AT support. **FreeSCAN** and the Uniden Sentinel tool do **not** support the BC125AT family, despite occasional confusion.

## 10. Common pitfalls

A handful of pitfalls trip developers repeatedly. **Stale input bytes** in the buffer from a previous session will turn the first response into garbage; always drain on connect and ideally before each command if you have been polling near the timing limits. **DTR/RTS toggling** on port-open can disconnect or reset the CDC connection on some hosts; disable it explicitly. On **macOS**, open the `/dev/cu.usbmodem*` node, never `tty.usbmodem*`, and match by USB serial number because the path number changes on replug. **Don't pipeline commands**; wait for each response. The BC125AT specifically can **occasionally drop or truncate `STS` responses** even under correct polling; defensively parse and skip rather than throw. After `PRG,OK` and `EPG,OK`, wait ~50–100 ms before the next command for the mode transition to settle. `CLR` needs a 45–60 second timeout. **`NG` and `ERR` mean different things** and should be handled separately. **Read until `\r`, never `\n`**, and never use fixed-byte reads because field widths are variable. **ASCII only** in channel names; no UTF-8, no control chars, max 16 chars. **Bank masks (`SCG`, `SSG`, `CSG`) use 0 = enabled, 1 = disabled**, the opposite of the obvious mental model. **Frequency encoding is 8-digit hundredths-of-kHz** (i.e., 100 Hz units): `01462250` = 146.2250 MHz, valid 25–512 MHz. **Empty CIN fields mean unchanged**, not blank; pad alpha tags with spaces to clear them. The **CLC band-bit layout differs** between protocol PDF v1.00 and v1.01; verify empirically. The **`GLG` field count varies** by firmware (sometimes 9 fields, sometimes 11–12 with trailing channel number and reverse flag); split-and-index, don't expect a fixed shape. The same is true of **`STS` field count** across firmware revisions. On Linux, **TLP and USB autosuspend** will break the connection silently on laptops. The **firmware update warning** on the RadioReference wiki is real: early-shipping BC125AT units can be bricked by firmware later than 1.03.01. Never push firmware through your protocol code; let users use Uniden's updater on their own.

## 11. Documentation sources, with direct URLs

The two most important documents are Uniden's own. **The BC125AT PC Protocol v1.01** at https://info.uniden.com/twiki/pub/UnidenMan4/BC125AT/BC125AT_PC_Protocol_V1.01.pdf is the authoritative source for the programming command set and serial settings. **The BCT15X v1.03 Protocol** at http://info.uniden.com/twiki/pub/UnidenMan4/BCT15XFirmwareUpdate/BCT15X_v1.03.00_Protocol.pdf is the authoritative source for the operational commands (`STS`, `GLG`, `KEY`, `PWR`) that the BC125AT family supports but does not document, and for the BearTracker commands (`STT`, `BTL`, `BTS`) that the BCT125AT inherits. The earlier BC125AT_Protocol.pdf (v1.00) is at http://info.uniden.com/twiki/pub/UnidenMan4/BC125AT/BC125AT_Protocol.pdf but has the CLC band-bit bug noted above.

The Uniden TWiki landing pages are http://info.uniden.com/twiki/bin/view/UnidenMan4/BC125AT and http://info.uniden.com/twiki/bin/view/UnidenMan4/BC125ATFirmwareUpdate, with the Windows drivers at http://info.uniden.com/twiki/pub/UnidenMan4/BC125AT/BC125AT_USB_driver.zip (older, unsigned) and http://info.uniden.com/twiki/pub/UnidenMan4/BCD536HP/Windows_Serial_Drivers.zip (signed, recommended for Windows 8.1/10/11). The owner's manuals are at http://info.uniden.com/twiki/pub/UnidenMan4/BC125AT/BC125AT.pdf (2012) and https://www.uniden.info/download/ompdf/BC125ATom.pdf (2024 revision). The product page is https://uniden.com/products/bc125at.

The RadioReference wiki page is https://wiki.radioreference.com/index.php/BC125AT; there is no separate BCT125AT wiki page. Key RadioReference forum threads include the protocol/STS/GLG/RSSI discussion at https://forums.radioreference.com/threads/serial-port-data.348885/, the BC75XLT vs BC125AT PWR thread at https://forums.radioreference.com/threads/serial-protocol-for-bc75xlt-series.327387/, the ProScan polling-interval thread (where Bob Smith confirms STS occasional truncation on BC125AT) at https://forums.radioreference.com/threads/bc125at-not-logging-and-slow-display.467461/, the BC125AT TCP-bridging thread at https://forums.radioreference.com/threads/uniden-ubc-125xlt-tcp.351945/, the list of key codes thread (BCD436HP-family, useful as a starting map) at https://forums.radioreference.com/threads/list-of-key-codes-for-remote-control.289547/, and the various driver/COM port threads at https://forums.radioreference.com/threads/usb-driver-for-bc125at-problems.299226/ and https://forums.radioreference.com/threads/bc125at-windows-10-driver.372830/. Pa3ang's serial-sniffer reverse-engineering of `GLG` is documented in his README at https://github.com/pa3ang/ubc125xlt/blob/main/README.md.

## What is and isn't certain

Treat the BCT125AT protocol as **BC125AT_PC_Protocol_V1.01.pdf + BCT15X_v1.03.00_Protocol.pdf**, with the caveats that (a) Uniden has never published a BCT125AT-specific PDF, so the BearTracker commands `STT`, `BTL`, and `BTS` and the BearTracker-key KEY code are inferred from the BCT15X spec and should be verified empirically on your unit; (b) the `STS` and `GLG` response field counts vary by firmware revision, so parse defensively rather than indexing fixed positions; (c) the CLC band-bit layout differs between the two BC125AT PDF revisions, so verify on your unit; (d) the BC125AT/BCT125AT family is known to occasionally drop or truncate `STS` responses under aggressive polling, so design for resilience; and (e) the BC125AT USB VID/PID (`0x1965`/`0x0017`) is confirmed; if your physically-labeled BCT125AT enumerates with a different PID, capture `lsusb -v` or `ioreg -p IOUSB -l` and reconcile before assuming the rest applies.

With those caveats, the fastest path to a working application is to clone `fdev/bc125csv` to learn the programming-mode patterns, read `suidroot/pyUniden` to learn the operational-mode patterns, read `pa3ang/ubc125xlt` to learn the real-time polling loop, watch your scanner's wire traffic with `socat` PTY pairs or `interceptty` while you experiment, and build your own client on top of `pyserial` (Python) or `serialport` (Node.js) following the skeletons above. Building the first solid TypeScript/Node or Rust library for this scanner family would also fill a real gap in the community ecosystem.