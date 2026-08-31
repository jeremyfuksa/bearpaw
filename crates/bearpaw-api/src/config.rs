//! Configuration for port, baud, API bind address.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tracing::{debug, warn};

/// Known Uniden scanner USB IDs probed during plug-and-play autodetect.
/// All current entries are Uniden America Corp. (`0x1965`).
/// See docs/SCANNER_PROTOCOL_REFERENCE.md §1 for the list.
pub const UNIDEN_VID: u16 = 0x1965;

const KNOWN_SCANNER_USB_IDS: &[(u16, u16)] = &[
    (UNIDEN_VID, 0x0017), // BC125AT, BCT125AT (shared PID)
    (UNIDEN_VID, 0x0018), // UBC125XLT (EU variant)
                          // Other Uniden 125/126 family PIDs (0x0016–0x001A) can be added here
                          // as they're confirmed.
];

/// Silicon Labs, maker of the CP210x USB-to-UART bridges.
///
/// The BC75XLT does not expose USB directly -- it sits behind a CP2104 bridge,
/// so it enumerates as `10c4:ea60` with Silicon Labs strings and nothing
/// mentioning Uniden anywhere. Verified 2026-08-26; see
/// `docs/wire_captures/2026-08-26/bc75xlt-compatibility.md`.
const SILICON_LABS_VID: u16 = 0x10C4;

/// Baud rates tried when probing an unidentified candidate port.
///
/// The two supported families disagree: BC125AT speaks 115200, BC75XLT 57600.
/// Ordered most-common-first; probing stops at the first rate yielding a valid
/// `MDL` reply, so the second entry costs a round-trip only when the first
/// fails.
const PROBE_BAUD_RATES: &[u32] = &[115_200, 57_600];

/// Model names returned by `MDL` that we accept as a real Uniden scanner.
/// Used by the autodetect MDL-probe step to confirm a candidate serial
/// port is the scanner before committing to it. See
/// `docs/BC125AT_PROTOCOL.md` §5.1.
/// `pub(crate)` so the capability-manifest test iterates the REAL allowlist.
/// A parallel list in the test would drift from this one, which is the exact
/// failure the manifest exists to catch.
pub(crate) const ACCEPTED_MDL_MODELS: &[&str] = &[
    "BC125AT",
    "BCT125AT",
    "UBC125XLT",
    "UBC126AT",
    "AE125H",
    // Same wire protocol, different memory model: 300 channels in banks of 30,
    // no alpha tags, boolean delay, 57600 baud. Driven via ScannerCapabilities
    // rather than the BC125AT-family constants. See #398.
    "BC75XLT",
];

/// Is this `MDL` model string a scanner Bearpaw can drive?
///
/// Exposed as a predicate rather than publishing `ACCEPTED_MDL_MODELS` so the
/// case-insensitive comparison lives in exactly one place. A caller handed the
/// raw slice would reach for `.contains(&model)`, which is an exact-match test
/// and would reject an otherwise-valid lowercase reply.
///
/// Originally the gate that kept BC125AT-family memory-model constants safe.
/// Those constants are gone -- channel count, bank width, delay range, and
/// coverage bands now come from `ScannerCapabilities`, resolved from this same
/// `MDL` reply (#399, #401, #402).
///
/// What it still decides is whether Bearpaw claims to *drive* the model at all.
/// An unlisted scanner is allowed to connect but flagged with an
/// `unsupported_model` diagnostic (#396), and it inherits BC125AT-family
/// capabilities by fallback -- so this list is what separates "we know this
/// hardware" from "we are guessing".
pub fn is_supported_model(model: &str) -> bool {
    ACCEPTED_MDL_MODELS
        .iter()
        .any(|known| model.eq_ignore_ascii_case(known))
}

/// The models Bearpaw drives, formatted for a user-facing message.
pub fn supported_models_list() -> String {
    ACCEPTED_MDL_MODELS.join(", ")
}

/// Sidecar filename for the most-recently-confirmed scanner. Lets us prefer
/// the same physical unit across reconnects when multiple scanners would
/// otherwise tie.
const LAST_SCANNER_CACHE_FILE: &str = "last_scanner.json";

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub device: DeviceConfig,
    #[serde(default)]
    pub api: ApiConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DeviceConfig {
    pub port: Option<String>,
    pub baud: Option<u32>,
    #[serde(default = "default_auto_detect")]
    pub auto_detect: bool,
    pub usb_vid: Option<u16>,
    pub usb_pid: Option<u16>,
    /// Assert DTR after opening the serial port. Default `false` — asserting
    /// DTR on open has caused intermittent disconnects on macOS/Linux and
    /// the BC125AT itself does not require it. Set to `true` only if your
    /// host/adapter combination demands it.
    #[serde(default)]
    pub assert_dtr_on_open: bool,
}

impl Default for DeviceConfig {
    fn default() -> Self {
        Self {
            port: None,
            baud: None,
            auto_detect: default_auto_detect(),
            usb_vid: None,
            usb_pid: None,
            assert_dtr_on_open: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ApiConfig {
    #[serde(default = "default_api_host")]
    pub host: String,
    #[serde(default = "default_api_port")]
    pub port: u16,
}

fn default_api_host() -> String {
    "127.0.0.1".to_string()
}

fn default_api_port() -> u16 {
    8000
}

fn default_auto_detect() -> bool {
    true
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            host: default_api_host(),
            port: default_api_port(),
        }
    }
}

/// Load config from YAML or TOML path. Falls back to default on read/parse errors.
pub fn load_config(path: Option<&str>) -> Config {
    let Some(path) = path else {
        return Config::default();
    };
    let p = Path::new(path);
    let Ok(raw) = fs::read_to_string(p) else {
        return Config::default();
    };
    // A config file that EXISTS but doesn't parse is a startup error, not a
    // silent fall-through to defaults (#143) — running with defaults when the
    // user explicitly configured usb_vid/usb_pid means "scanner not found"
    // with no hint why.
    let cfg: Config = if path.ends_with(".toml") {
        match toml::from_str(&raw) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("error: failed to parse config {}: {}", path, e);
                std::process::exit(2);
            }
        }
    } else {
        match serde_yaml::from_str(&raw) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("error: failed to parse config {}: {}", path, e);
                std::process::exit(2);
            }
        }
    };
    if cfg.device.usb_vid.is_some() != cfg.device.usb_pid.is_some() {
        eprintln!(
            "warning: config sets only one of device.usb_vid / device.usb_pid — both are required for the direct-USB path; ignoring"
        );
    }
    cfg
}

/// Resolved scanner connection: which port to open, plus the baud rate that
/// actually produced a valid `MDL` reply.
///
/// The baud must travel with the port. Detection can discover that a scanner
/// speaks 57600 while `device.baud` says 115200, and handing the poll loop only
/// the port name would have it reopen at the configured rate and fail -- with
/// detection having just proven that rate wrong.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedPort {
    pub port_name: String,
    pub baud: u32,
}

/// Resolve the scanner connection from config: explicit port first, then USB
/// auto-detect.
///
/// Precedence:
/// 1. `device.port` in config (explicit override; user gets exactly what they ask for).
/// 2. `device.usb_vid` + `device.usb_pid` (explicit USB target; matched against
///    serial enumeration first, then falls back to the `usb:` pseudo-target).
/// 3. Cached-serial-number lookup from the last successful autodetect.
/// 4. Scored serial-port candidates, deduped to one entry per physical device,
///    with an MDL probe across the known baud rates to confirm the winner is
///    actually a scanner before committing.
/// 5. Direct USB probe for known Uniden VID/PIDs (macOS no-CDC-bind fallback).
pub fn resolve_scanner_port(cfg: &Config) -> Option<ResolvedPort> {
    let baud = cfg.device.baud.unwrap_or(115200);

    if let Some(port) = cfg.device.port.clone() {
        if !port.is_empty() {
            // An explicit port is the user overriding detection. Probe for the
            // working rate anyway (they may not know their scanner's baud), but
            // never reject the port they named.
            let (_, rate) = probe_mdl_on_port_any_baud(&port, baud);
            return Some(ResolvedPort {
                port_name: port,
                baud: rate,
            });
        }
    }

    // VID/PID-configured path: try matching a serial TTY first, otherwise fall back
    // to the USB pseudo-target so the poll loop uses direct bulk endpoints. Runs even
    // when auto_detect is false or no serial candidates exist (macOS sometimes
    // enumerates the device at the USB level without binding AppleUSBCDCACMData).
    if let (Some(vid), Some(pid)) = (cfg.device.usb_vid, cfg.device.usb_pid) {
        if let Ok(ports) = serialport::available_ports() {
            for p in ports.iter().filter(|p| !is_blocked_port(p)) {
                if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                    if info.vid == vid && info.pid == pid {
                        let (_, rate) = probe_mdl_on_port_any_baud(&p.port_name, baud);
                        return Some(ResolvedPort {
                            port_name: p.port_name.clone(),
                            baud: rate,
                        });
                    }
                }
            }
        }
        return Some(ResolvedPort {
            port_name: format!("usb:{:04x}:{:04x}", vid, pid),
            baud,
        });
    }

    if !cfg.device.auto_detect {
        return None;
    }

    let available: Vec<_> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !is_blocked_port(p))
        .collect();

    // Cached-serial-number step: if we've successfully identified a scanner
    // in a previous session and it's still plugged in, prefer it. Lets the
    // user keep multiple Uniden scanners attached without surprises.
    if let Some(cache) = load_last_scanner_cache() {
        for p in &available {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                if info.serial_number.as_deref() == Some(cache.serial_number.as_str())
                    && matches!(
                        probe_mdl_on_port_any_baud(&p.port_name, baud).0,
                        MdlProbe::Supported
                    )
                {
                    let (_, rate) = probe_mdl_on_port_any_baud(&p.port_name, baud);
                    debug!(
                        "resolved scanner via cached serial number {}: {} @ {} baud",
                        cache.serial_number, p.port_name, rate
                    );
                    return Some(ResolvedPort {
                        port_name: p.port_name.clone(),
                        baud: rate,
                    });
                }
            }
        }
    }

    // Scored-and-MDL-probed step: score the available ports, then in
    // descending score order, MDL-probe each candidate. The first one that
    // replies with a valid `MDL,<model>` we accept (per ACCEPTED_MDL_MODELS).
    // If no candidate responds, fall through to the USB-direct probe so
    // macOS no-CDC-bind still works.
    let scored: Vec<(i32, String)> = available
        .iter()
        .filter_map(|p| score_port(p).map(|score| (score, p.port_name.clone())))
        .collect();
    let scored = dedupe_physical_devices(scored, &available);
    for (score, name) in &scored {
        if *score <= 0 {
            break;
        }
        match probe_mdl_on_port_any_baud(name, baud) {
            (MdlProbe::Supported, rate) => {
                if rate != baud {
                    debug!(
                        "resolved scanner on {} at {} baud (configured {})",
                        name, rate, baud
                    );
                }
                return Some(ResolvedPort {
                    port_name: name.clone(),
                    baud: rate,
                });
            }
            // Keep scanning other candidates: the unsupported unit may not be
            // the only Uniden on the bus. The warn! in probe_mdl_on_port has
            // already told the user what we found and why we skipped it.
            (MdlProbe::Unsupported, _) | (MdlProbe::NoReply, _) | (MdlProbe::OpenFailed, _) => {
                continue
            }
        }
    }

    // Second-pass: probe USB directly for any known Uniden scanner. This is
    // the path hit when macOS sees the device but never binds
    // AppleUSBCDCACMData, leaving no /dev/cu.usbmodem* serial node.
    if let Some((vid, pid)) = probe_known_scanner_via_usb() {
        return Some(ResolvedPort {
            port_name: format!("usb:{:04x}:{:04x}", vid, pid),
            baud,
        });
    }

    None
}

/// Rank a USB device as a scanner candidate. Lower is better; `None` means
/// "not a candidate".
///
/// See `rank_usb_candidate` docs for why the Uniden-VID tier exists.
fn usb_candidate_rank(vid: u16, pid: u16) -> Option<u8> {
    if KNOWN_SCANNER_USB_IDS.contains(&(vid, pid)) {
        return Some(0);
    }
    // NO CP210x TIER HERE, deliberately. #419 added one, reasoning that the
    // BC75XLT carries no Uniden identifiers -- but this function feeds ONLY
    // `probe_known_scanner_via_usb`, whose result becomes a `usb:vid:pid`
    // pseudo-target handed to `UsbTransport`. That transport hardcodes the
    // Uniden CDC-ACM layout (interface 1, endpoints 0x81/0x02) and issues none
    // of the CP210x vendor control requests a bridge needs, so it cannot drive
    // one -- and on the way to failing it detaches the kernel driver, which on
    // Linux strips `cp210x` off the bridge and takes the `ttyUSB` node with it
    // until the user replugs. That would hit any CP210x on the bus, including
    // devices with nothing to do with Bearpaw.
    //
    // The tier bought nothing anyway: `score_port` already ranks the BC75XLT's
    // serial node at 60 and the multi-baud MDL probe confirms it, so the serial
    // path wins whenever the node is openable. The USB fallback exists for the
    // macOS no-CDC-bind case, which is a Uniden-only problem.
    if vid == UNIDEN_VID {
        return Some(1);
    }
    None
}

/// Walk rusb's device list and return the best scanner candidate's VID/PID.
///
/// Two tiers, best-first:
///
/// 0. VID/PID present in `KNOWN_SCANNER_USB_IDS` — a scanner we have seen.
/// 1. Any device on `UNIDEN_VID` — Uniden owns that vendor ID, so the device
///    is a Uniden product even if we have not catalogued this PID.
///
/// Tier 1 exists because `KNOWN_SCANNER_USB_IDS` was the sole gate on this
/// path while `ACCEPTED_MDL_MODELS` carries five models against two PIDs. On
/// macOS no serial node appears (see `CLAUDE.md` -> "macOS USB transport"), so
/// this function is the *only* discovery path, and a supported scanner on an
/// uncatalogued PID reported the generic "no scanner found" (#392). The serial
/// path already matched loosely on `"uniden"` product strings in `score_port`;
/// this brings the USB path to parity.
///
/// Tier 1 asserts nothing about which model a PID is — it says "this is a
/// Uniden device, ask it what it is". The answer comes from `MDL` on the wire
/// and is checked against `is_supported_model` at the connect chokepoint in
/// `api::poll::update_device_info_from_mdl`. That keeps the captures-win rule
/// in `CLAUDE.md` satisfied: no unverified PID-to-model mapping enters the
/// tree.
///
/// Ordering is load-bearing. A known PID must always win over an uncatalogued
/// one so the common case is unchanged and a non-scanner Uniden peripheral
/// (cordless base, dash cam) can never displace a real scanner.
///
/// Test: `known_pid_outranks_unknown_uniden_pid`.
fn probe_known_scanner_via_usb() -> Option<(u16, u16)> {
    use rusb::UsbContext;
    let ctx = rusb::Context::new().ok()?;
    let devices = ctx.devices().ok()?;

    let mut best: Option<(u8, u16, u16)> = None;
    for dev in devices.iter() {
        let Ok(desc) = dev.device_descriptor() else {
            continue;
        };
        let (vid, pid) = (desc.vendor_id(), desc.product_id());
        let Some(rank) = usb_candidate_rank(vid, pid) else {
            continue;
        };
        if best.is_none_or(|(best_rank, _, _)| rank < best_rank) {
            best = Some((rank, vid, pid));
        }
        // Rank 0 is the best possible; no point walking the rest of the bus.
        if rank == 0 {
            break;
        }
    }

    if let Some((rank, vid, pid)) = best {
        if rank > 0 {
            // warn! so it lands in a log the user actually sends us. This is
            // the report path for an uncatalogued PID -- see #392. Deliberately
            // log-only: the scanner works, and a UI nudge on a working device
            // is worse UX than silence.
            warn!(
                "Found a Uniden device at {:04x}:{:04x} that is not in the known-scanner \
                 PID list. Treating it as a scanner candidate; the MDL reply decides. \
                 If Bearpaw works with this device, please report this USB ID at \
                 https://github.com/jeremyfuksa/bearpaw/issues so it can be recognised \
                 directly.",
                vid, pid
            );
        }
        return Some((vid, pid));
    }
    None
}

fn is_blocked_port(p: &serialport::SerialPortInfo) -> bool {
    let n = p.port_name.to_lowercase();
    if n.contains("debug-console") || n.contains("bluetooth") || n.contains("incoming-port") {
        return true;
    }
    if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
        let product = info.product.as_deref().unwrap_or_default().to_lowercase();
        if product.contains("bluetooth") || product.contains("debug") {
            return true;
        }
    }
    false
}

fn score_port(p: &serialport::SerialPortInfo) -> Option<i32> {
    let n = p.port_name.to_lowercase();
    let mut score = 0;
    match &p.port_type {
        serialport::SerialPortType::UsbPort(info) => {
            score += 20;
            let product = info.product.as_deref().unwrap_or_default().to_lowercase();
            let manufacturer = info
                .manufacturer
                .as_deref()
                .unwrap_or_default()
                .to_lowercase();
            if product.contains("uniden") || manufacturer.contains("uniden") {
                score += 100;
            }
            // A CP210x bridge is how the BC75XLT reaches the host, and the
            // SERIAL path is the only one that can drive it -- see the note in
            // `usb_candidate_rank`. Scoring it explicitly makes that the stated
            // intent rather than something it happens to earn from the generic
            // rules below. Ranked well under Uniden: the bridge says nothing
            // about what is behind it, so the MDL probe still decides.
            if info.vid == SILICON_LABS_VID {
                score += 25;
            }
            if product.contains("usb") {
                score += 10;
            }
        }
        _ => {}
    }
    if n.contains("usbmodem")
        || n.contains("usbserial")
        || n.contains("/dev/cu.usb")
        || n.contains("/dev/tty.usb")
    {
        score += 30;
    }
    // Prefer the call-up node over its tty sibling. macOS exposes both
    // `/dev/cu.X` and `/dev/tty.X` for one device; `tty.*` blocks on open
    // waiting for carrier detect, which a scanner never asserts, so probing one
    // can hang startup detection rather than merely wasting a round-trip.
    // Linux's `ttyUSB0` / `ttyACM0` are unaffected -- they do not carry the
    // `/dev/tty.` prefix this matches.
    if n.starts_with("/dev/tty.") {
        score -= 15;
    }
    if n.contains("soundcore") {
        score -= 50;
    }
    Some(score)
}

/// Collapse ports that are the same physical device down to one candidate.
///
/// One scanner can present as four nodes. The BC75XLT's CP2104 is claimed by
/// both Apple's `AppleUSBSLCOM` driver and Silicon Labs' own `com.silabs.cp210x`,
/// and each exposes a `cu.`/`tty.` pair:
///
/// ```text
/// /dev/cu.usbserial-020D43D8   /dev/tty.usbserial-020D43D8
/// /dev/cu.SLAB_USBtoUART       /dev/tty.SLAB_USBtoUART
/// ```
///
/// All four report USB serial `020D43D8`. Probing each in turn means four opens
/// of one scanner, and opening two nodes of the same device concurrently can
/// wedge the port. Dedupe on `(vid, pid, serial)`, keeping the highest-scoring
/// node -- which `score_port`'s `tty.` penalty makes the `cu.` one.
///
/// Devices reporting no serial number cannot be collapsed safely (two identical
/// adapters would be indistinguishable), so they are all kept.
fn dedupe_physical_devices(
    mut scored: Vec<(i32, String)>,
    ports: &[serialport::SerialPortInfo],
) -> Vec<(i32, String)> {
    use std::collections::HashSet;

    let identity = |name: &str| -> Option<(u16, u16, String)> {
        ports
            .iter()
            .find(|p| p.port_name == name)
            .and_then(|p| match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => info
                    .serial_number
                    .as_ref()
                    .map(|sn| (info.vid, info.pid, sn.clone())),
                _ => None,
            })
    };

    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let mut seen: HashSet<(u16, u16, String)> = HashSet::new();
    scored.retain(|(_, name)| match identity(name) {
        Some(key) => seen.insert(key),
        None => true,
    });
    scored
}

/// Outcome of an `MDL` probe on a candidate port.
///
/// The `Unsupported` arm exists so the caller can tell "nothing answered" from
/// "a real Uniden answered with a model we don't drive yet" — the two used to
/// collapse into `None`, which is why an unsupported scanner reported the same
/// generic "no scanner found" as an empty USB bus.
///
/// `OpenFailed` exists for the same reason, one layer down: the OS refusing
/// the port is a different fact from the port opening and nothing answering,
/// and folding it into `NoReply` discarded the only evidence that the scanner
/// was present at all.
enum MdlProbe {
    Supported,
    Unsupported,
    NoReply,
    OpenFailed,
}

/// Briefly open a serial port, send `MDL\r`, and classify what answered.
/// Used by the autodetect path to avoid committing to a port that scored
/// well but isn't actually our hardware (e.g. an unrelated USB-serial
/// device).
///
/// Best-effort and tolerant: a read/parse failure yields `MdlProbe::NoReply`,
/// and a port the OS refuses to open yields `MdlProbe::OpenFailed` (logged at
/// `warn!`); either way the caller falls through to the next candidate.
/// A scanner that answers with a model outside `ACCEPTED_MDL_MODELS` yields
/// `MdlProbe::Unsupported` and logs a `warn!` naming the model — see the
/// enum docs for why those two cases stay distinct. Does **not** assert DTR
/// (per Phase 9b) and uses a 500 ms read timeout (default).
/// Probe a port across every rate in `PROBE_BAUD_RATES`, returning the first
/// conclusive answer along with the rate that produced it.
///
/// Exists because the supported families disagree on baud: BC125AT speaks
/// 115200, BC75XLT 57600. At the wrong rate a scanner returns framing garbage
/// that `parse_mdl_response` rejects, which is indistinguishable from an empty
/// port -- so a single-rate probe reports "no scanner found" for a scanner that
/// is plugged in and working.
///
/// `configured` is tried first and is never skipped: an explicit `device.baud`
/// is the user stating what their hardware speaks, and detection must not
/// second-guess it.
fn probe_mdl_on_port_any_baud(port_name: &str, configured: u32) -> (MdlProbe, u32) {
    let mut rates = vec![configured];
    rates.extend(
        PROBE_BAUD_RATES
            .iter()
            .copied()
            .filter(|r| *r != configured),
    );

    let mut best = MdlProbe::NoReply;
    for rate in rates {
        match probe_mdl_on_port(port_name, rate) {
            MdlProbe::Supported => return (MdlProbe::Supported, rate),
            // A real scanner answered, just not one we drive. Conclusive for
            // this port -- keep it, but let a later rate upgrade to Supported
            // in the (unlikely) case two rates both parse.
            MdlProbe::Unsupported => best = MdlProbe::Unsupported,
            // Retrying other rates cannot help -- the port never opened, and
            // each retry would re-emit the warn! above for one root cause.
            MdlProbe::OpenFailed => return (MdlProbe::OpenFailed, rate),
            MdlProbe::NoReply => {}
        }
    }
    (best, configured)
}

fn probe_mdl_on_port(port_name: &str, baud: u32) -> MdlProbe {
    use crate::transport::SerialTransport;
    let transport = SerialTransport::new(port_name, baud);
    let mut port = match transport.open() {
        Ok(port) => port,
        Err(e) => {
            // warn! for the same reason the responding-but-unsupported case
            // below is a warn: the user has done nothing wrong and the generic
            // "no scanner found" is actively misleading. A port that scored
            // high enough to reach this probe and then refused to open means
            // the scanner IS present and something else is wrong.
            //
            // Observed 2026-08-27: installing Silicon Labs' CP210x driver
            // alongside the built-in AppleUSBSLCOM attaches BOTH to the same
            // USB interface -- they declare different `IOMatchCategory`
            // values, so IOKit does not pick a winner -- and every resulting
            // node then fails to open with "Invalid argument". Swallowing the
            // error made that indistinguishable from an empty USB bus.
            warn!(
                "Scanner candidate {} could not be opened at {} baud: {}. The port \
                 exists but the OS refused it, so a scanner may well be attached. On \
                 macOS this is usually two CP210x drivers claiming one device -- \
                 disable the Silicon Labs driver extension under System Settings > \
                 General > Login Items & Extensions > Driver Extensions. Otherwise \
                 the port is likely held by another program.",
                port_name, baud, e
            );
            return MdlProbe::OpenFailed;
        }
    };

    // Retry the first MDL. Verified on a BC75XLT behind a CP2104 bridge
    // (2026-08-26): the FIRST command after a fresh open reliably returns
    // `ERR`, every subsequent one returns `MDL,BC75XLT`. The bridge buffers
    // whatever was on the line at open, so the first command arrives with a
    // garbage prefix and the scanner correctly rejects it.
    //
    // The poll loop already tolerates this -- update_device_info_from_mdl
    // retries MDL five times for exactly this reason. Without the same
    // tolerance here, detection is stricter than the connection path it feeds:
    // it reports "no scanner found" for a port the poll loop would connect to
    // on its second attempt.
    let mut response = String::new();
    for attempt in 1..=3 {
        match transport.send(port.as_mut(), "MDL") {
            Ok(r) if crate::protocol::parse_mdl_response(&r).is_some() => {
                response = r;
                break;
            }
            Ok(r) => {
                debug!(
                    "MDL probe on {} @ {}: attempt {} returned {:?}, retrying",
                    port_name,
                    baud,
                    attempt,
                    r.trim()
                );
                response = r;
            }
            Err(_) => return MdlProbe::NoReply,
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }

    let Some(model) = crate::protocol::parse_mdl_response(&response) else {
        return MdlProbe::NoReply;
    };
    if is_supported_model(&model) {
        debug!("MDL probe on {}: matched model {}", port_name, model);
        MdlProbe::Supported
    } else {
        // Surfaced at warn! rather than debug! so it lands in the log a user
        // actually sends us. A responding-but-unsupported scanner is the one
        // detection outcome where the user has done nothing wrong and the
        // generic "no scanner found" is actively misleading.
        warn!(
            "Found a Uniden scanner on {} reporting model {:?}, but Bearpaw does not support it yet. \
             Supported models: {}. Bearpaw targets the conventional analog 125/126 family; \
             trunking scanners (TrunkTracker systems/sites/groups) use a different memory model. \
             Please report this model at https://github.com/jeremyfuksa/bearpaw/issues so support can be considered.",
            port_name,
            model,
            supported_models_list()
        );
        MdlProbe::Unsupported
    }
}

/// On-disk record of the most-recently-confirmed scanner. Lets autodetect
/// prefer the same physical unit across reconnects.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LastScannerCache {
    /// USB serial number, from `serialport::UsbPortInfo` on a serial node or
    /// the USB device descriptor on the direct path.
    ///
    /// It does NOT distinguish two units of the same model, whatever it looks
    /// like. A BC125AT reports `0001` for every unit ever made -- a firmware
    /// constant, measured on hardware 2026-08-26. Only the BC75XLT has a real
    /// per-unit value, and only because its CP2104 bridge is programmed by
    /// Silicon Labs rather than Uniden.
    ///
    /// What it IS good for is what this cache uses it for: preferring the same
    /// physical port across reconnects. See `scanner_registry` for the
    /// identity model built on top of it, and the limitation it documents.
    serial_number: String,
    /// Last-known port path (`/dev/cu.usbmodemXXX`, `COM3`, etc). Recorded
    /// for debugging; the serial number is the actual lookup key.
    port_name: String,
    /// Model returned by `MDL` when we last confirmed this unit.
    model: String,
}

fn last_scanner_cache_path() -> PathBuf {
    crate::api::default_data_dir().join(LAST_SCANNER_CACHE_FILE)
}

fn load_last_scanner_cache() -> Option<LastScannerCache> {
    let path = last_scanner_cache_path();
    let mut file = fs::File::open(&path).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    match serde_json::from_str::<LastScannerCache>(&buf) {
        Ok(cache) => Some(cache),
        Err(e) => {
            warn!("ignoring malformed scanner cache at {:?}: {}", path, e);
            None
        }
    }
}

/// Persist the most-recently-confirmed scanner so a future startup can
/// prefer it. Called from `update_device_info_from_mdl` in the poll loop
/// once MDL has confirmed a port works.
///
/// Best-effort: any I/O error is logged but not surfaced. The autodetect
/// path degrades gracefully to scoring + MDL-probe if the cache is missing
/// or unreadable.
pub fn save_last_scanner_cache(serial_number: &str, port_name: &str, model: &str) {
    let cache = LastScannerCache {
        serial_number: serial_number.to_string(),
        port_name: port_name.to_string(),
        model: model.to_string(),
    };
    let path = last_scanner_cache_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = match serde_json::to_string_pretty(&cache) {
        Ok(s) => s,
        Err(e) => {
            warn!("failed to serialise scanner cache: {}", e);
            return;
        }
    };
    match fs::File::create(&path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(json.as_bytes()) {
                warn!("failed to write scanner cache {:?}: {}", path, e);
            }
        }
        Err(e) => warn!("failed to create scanner cache {:?}: {}", path, e),
    }
}

/// Find the USB serial number for a port that was just confirmed via MDL.
/// Returns None if the port isn't a USB serial device or has no serial
/// number reported. Public so the poll loop can call it when committing
/// to a port.
pub fn usb_serial_for_port(port_name: &str) -> Option<String> {
    // The macOS BC125AT path has no serial node at all -- the kernel never
    // binds CDC-ACM, so `available_ports()` cannot see it and this returned
    // None purely as an accident of which transport ran. Read the descriptor
    // directly instead, so the match index is built the same way on both
    // transports and a missing serial is a real answer rather than a side
    // effect. See `scanner_registry::match_index`.
    if let Some((vid, pid)) = parse_usb_pseudo_target(port_name) {
        return usb_serial_from_descriptor(vid, pid);
    }
    let ports = serialport::available_ports().ok()?;
    for p in ports {
        if names_the_same_port(port_name, &p.port_name) {
            if let serialport::SerialPortType::UsbPort(info) = p.port_type {
                return info.serial_number;
            }
        }
    }
    None
}

/// Do two port names refer to the same device node?
///
/// REGRESSION GUARD (`a_symlinked_port_name_matches_the_node_it_points_at`):
/// a plain `==` was not enough (#570).
///
/// `resolve_scanner_port` returns an explicit `device.port` VERBATIM -- "user
/// gets exactly what they ask for" -- while `available_ports()` always reports
/// real device nodes. The stable idiom a Linux user is told to pin,
/// `/dev/serial/by-id/usb-Silicon_Labs_CP2102_...`, is a symlink to
/// `/dev/ttyUSB0`, so it matched nothing, the serial read returned None, and
/// that config resolved to `BC75XLT:unknown` while autodetect on the same
/// machine resolved to `BC75XLT:020D43D8`. Two profiles, two channel caches,
/// one radio, and no log line explaining it.
///
/// The string comparison comes FIRST and is the only thing that runs in the
/// common case. `canonicalize` is a syscall per candidate port, and it fails
/// for anything that is not a filesystem path -- a Windows `COM3`, or a port
/// that has just been unplugged. Falling back to name equality keeps those
/// working exactly as before rather than turning a resolvable port into an
/// unmatchable one.
fn names_the_same_port(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// `usb:VVVV:PPPP` -> `(vid, pid)`. The pseudo-target the poll loop uses when
/// there is no serial node to name.
fn parse_usb_pseudo_target(target: &str) -> Option<(u16, u16)> {
    let rest = target.strip_prefix("usb:")?;
    let (v, p) = rest.split_once(':')?;
    Some((
        u16::from_str_radix(v.trim(), 16).ok()?,
        u16::from_str_radix(p.trim(), 16).ok()?,
    ))
}

/// The USB serial string from the device descriptor.
///
/// Best-effort in every direction: an unreadable descriptor on an unrelated
/// device is skipped rather than failing the scan (the #143 rule), and a device
/// that reports no serial yields None. Never opens a data endpoint, so it
/// cannot disturb a session the poll loop is holding.
fn usb_serial_from_descriptor(vid: u16, pid: u16) -> Option<String> {
    use rusb::UsbContext;
    let ctx = rusb::Context::new().ok()?;
    for dev in ctx.devices().ok()?.iter() {
        let Ok(desc) = dev.device_descriptor() else {
            continue;
        };
        if desc.vendor_id() != vid || desc.product_id() != pid {
            continue;
        }
        let Ok(handle) = dev.open() else { continue };
        return handle
            .read_serial_number_string_ascii(&desc)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `usb:` pseudo-target parses back to the ids it names.
    ///
    /// This is what routes a BC125AT to the descriptor read instead of to
    /// `available_ports()`, which cannot see it -- on macOS the kernel never
    /// binds CDC-ACM for that model, so no `/dev/cu.*` node exists at all.
    #[test]
    fn a_usb_pseudo_target_parses_to_its_ids() {
        assert_eq!(
            parse_usb_pseudo_target("usb:1965:0017"),
            Some((0x1965, 0x0017))
        );
        assert_eq!(
            parse_usb_pseudo_target("usb:10c4:ea60"),
            Some((0x10C4, 0xEA60))
        );
    }

    /// Anything that is not a pseudo-target falls through to the serial-node
    /// lookup rather than being misread.
    #[test]
    fn a_serial_node_is_not_mistaken_for_a_pseudo_target() {
        assert_eq!(parse_usb_pseudo_target("/dev/cu.usbserial-020D43D8"), None);
        assert_eq!(parse_usb_pseudo_target("COM3"), None);
        assert_eq!(parse_usb_pseudo_target("usb:nothex:0017"), None);
        assert_eq!(parse_usb_pseudo_target("usb:1965"), None);
    }

    /// REGRESSION GUARD (#570): a port named through a symlink is the SAME port
    /// as the node it points at.
    ///
    /// `resolve_scanner_port` returns an explicit `device.port` verbatim -- its
    /// comment says so: "user gets exactly what they ask for". That string then
    /// reaches `usb_serial_for_port`, which compares it against the names
    /// `serialport::available_ports()` reports. Those are always real device
    /// nodes.
    ///
    /// So the stable idiom a Linux user is told to pin --
    ///
    /// ```yaml
    /// device:
    ///   port: /dev/serial/by-id/usb-Silicon_Labs_CP2102_...
    /// ```
    ///
    /// -- never matched any `p.port_name`, which are `/dev/ttyUSB0`. The serial
    /// read returned None, so that config yielded `BC75XLT:unknown` while
    /// autodetect on the SAME machine yielded `BC75XLT:020D43D8`: two profiles,
    /// two channel caches, one radio, and nothing in the log saying why.
    ///
    /// `update_device_info_from_mdl`'s own doc names an explicit `device.port`
    /// as a first-class connection path, so this is a supported configuration
    /// rather than an edge case.
    ///
    /// Tested with an ordinary file and symlink because a test cannot conjure a
    /// device node. The resolution rule is the same one the OS applies.
    #[test]
    fn a_symlinked_port_name_matches_the_node_it_points_at() {
        let dir = std::env::temp_dir().join(format!(
            "bearpaw-port-link-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create dir");
        let node = dir.join("ttyUSB0");
        std::fs::write(&node, b"").expect("create node");
        let by_id = dir.join("usb-Silicon_Labs_CP2102_020D43D8-if00-port0");
        std::os::unix::fs::symlink(&node, &by_id).expect("create symlink");

        let configured = by_id.to_str().expect("path");
        let enumerated = node.to_str().expect("path");

        assert!(
            names_the_same_port(configured, enumerated),
            "a by-id symlink and its target are one port"
        );
        assert!(
            names_the_same_port(enumerated, configured),
            "and the comparison is symmetric"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other direction, and not optional: two different ports stay
    /// different. Asserting only that a symlink matches would pass for a build
    /// where every port matches every other, which would hand one radio's
    /// serial to whichever node enumerated first.
    #[test]
    fn two_different_ports_are_not_the_same_port() {
        assert!(!names_the_same_port("/dev/ttyUSB0", "/dev/ttyUSB1"));
        assert!(!names_the_same_port(
            "/dev/cu.usbserial-A",
            "/dev/cu.usbserial-B"
        ));
    }

    /// A path that does not exist still compares by name.
    ///
    /// Canonicalising fails for a port that has been unplugged, or for a
    /// Windows name like `COM3` that is not a filesystem path at all. Falling
    /// back to string equality keeps those working exactly as before rather
    /// than turning a resolvable port into an unmatchable one.
    #[test]
    fn a_nonexistent_port_still_matches_itself_by_name() {
        assert!(names_the_same_port("COM3", "COM3"));
        assert!(names_the_same_port(
            "/dev/cu.usbmodem-gone",
            "/dev/cu.usbmodem-gone"
        ));
        assert!(!names_the_same_port("COM3", "COM4"));
    }

    /// Live hardware: read the serial off a connected BC125AT.
    ///
    /// `#[ignore]`d because it needs the radio attached, like the transport's
    /// own live test. Run with:
    ///
    /// ```text
    /// cargo test -p bearpaw-api --lib -- --ignored usb_serial
    /// ```
    ///
    /// Worth running WHILE the app is connected: this opens the device to read
    /// a string descriptor over the control endpoint, and the poll loop holds
    /// the bulk endpoints. If the two cannot coexist, the function returns None
    /// on exactly the path it exists to serve -- and it would do so silently.
    ///
    /// Expect `0001` on a BC125AT. That is a firmware constant, identical on
    /// every unit; it is not a per-unit id. See `scanner_registry`.
    ///
    /// ANSWERED ON HARDWARE 2026-08-31: there is NO contention. A second
    /// `rusb::Context` can open a BC125AT that `UsbTransport` has already
    /// opened and claimed, on macOS, and read the string descriptor.
    ///
    /// This was #570's open question and it shipped unverified, because
    /// nothing in CI touches the direct-USB path and this function's own doc
    /// comment flagged the failure as one that would be silent.
    ///
    /// How it was settled. A backend was run from source against a live
    /// BC125AT with `usb_vid`/`usb_pid` configured, so `resolve_scanner_port`
    /// fell through to the `usb:1965:0017` pseudo-target -- confirmed by the
    /// absence of a `last_scanner.json`, which `update_device_info_from_mdl`
    /// skips writing for a `usb:` port. `update_device_info_from_mdl` then ran
    /// `usb_serial_for_port` on that target while the poll loop held the bulk
    /// endpoints, and `resolve_scanner` persisted the result. The row it wrote:
    ///
    /// ```text
    /// match_index | model   | usb_serial
    /// BC125AT     | BC125AT | 0001
    /// ```
    ///
    /// A `usb_serial` of `0001` rather than NULL is the descriptor read
    /// succeeding against a claimed device. It also re-confirms the firmware
    /// constant -- see `scanner_registry::match_index`, which is why the
    /// `match_index` column has no serial segment.
    ///
    /// So the descriptor read does NOT need replacing with a
    /// serial-captured-during-`UsbTransport::open()` scheme. What remains is
    /// only that the call is now WASTED for this family: `match_index` ignores
    /// a BC125AT's serial, so the one path that takes this branch discards the
    /// answer. Skipping the read when `has_unique_usb_serial` is false would
    /// remove a syscall, not a hazard.
    ///
    /// A BC75XLT never takes this path at all -- its CP210x binds normally, so
    /// it resolves through `available_ports()`.
    #[test]
    #[ignore]
    fn usb_serial_reads_from_a_live_bc125at() {
        let serial = usb_serial_for_port("usb:1965:0017");
        println!("BC125AT serial over the direct path: {serial:?}");
        assert!(
            serial.is_some(),
            "expected a serial from the device descriptor; got None. \
             If the app is running, this may mean the read cannot share the \
             device with the poll loop."
        );
    }

    fn usb_port(
        name: &str,
        vid: u16,
        pid: u16,
        serial: Option<&str>,
    ) -> serialport::SerialPortInfo {
        serialport::SerialPortInfo {
            port_name: name.to_string(),
            port_type: serialport::SerialPortType::UsbPort(serialport::UsbPortInfo {
                vid,
                pid,
                serial_number: serial.map(|s| s.to_string()),
                manufacturer: Some("Silicon Labs".into()),
                product: Some("CP2104 USB to UART Bridge Controller".into()),
            }),
        }
    }

    /// REGRESSION GUARD: a CP210x bridge must NEVER become a direct-USB target.
    ///
    /// `usb_candidate_rank` feeds only `probe_known_scanner_via_usb`, whose
    /// result becomes a `usb:vid:pid` pseudo-target handed to `UsbTransport` --
    /// which hardcodes the Uniden CDC-ACM layout and cannot drive a bridge. On
    /// the way to failing, `UsbTransport::open` detaches the kernel driver,
    /// which on Linux strips `cp210x` and takes the `ttyUSB` node with it until
    /// the user replugs. That would hit ANY CP210x on the bus -- ESP32 boards,
    /// radio programming cables -- on a machine with no scanner attached.
    ///
    /// #419 added a CP210x tier here and it was wrong: the BC75XLT is found on
    /// the SERIAL path, where `score_port` ranks its node at 60 and the
    /// multi-baud MDL probe confirms it. The USB fallback exists for the macOS
    /// no-CDC-bind case, which is Uniden-only.
    #[test]
    fn a_cp210x_bridge_is_never_a_direct_usb_target() {
        assert_eq!(
            usb_candidate_rank(SILICON_LABS_VID, 0xEA60),
            None,
            "UsbTransport cannot drive a CP210x, and reaching it detaches the \
             kernel driver on the way to failing"
        );
        assert_eq!(usb_candidate_rank(UNIDEN_VID, 0x0017), Some(0));
        assert_eq!(usb_candidate_rank(UNIDEN_VID, 0x9999), Some(1));
        assert_eq!(usb_candidate_rank(0x1234, 0x5678), None);
    }

    /// The paired half: removing the tier must not break BC75XLT detection,
    /// which happens on the serial path. Its node still has to outscore noise.
    #[test]
    fn the_cp210x_serial_node_is_still_a_strong_candidate() {
        let cp = usb_port(
            "/dev/cu.usbserial-020D43D8",
            SILICON_LABS_VID,
            0xEA60,
            Some("X"),
        );
        let score = score_port(&cp).expect("a CP210x serial node must be scored");
        assert!(
            score >= 60,
            "the BC75XLT is detected on the serial path, so its node must score \
             well above zero: got {score}"
        );
    }

    /// REGRESSION GUARD: one scanner can present as four serial nodes. The
    /// BC75XLT's CP2104 is claimed by both AppleUSBSLCOM and Silicon Labs'
    /// driver, and each exposes a cu./tty. pair -- all four reporting serial
    /// 020D43D8. Probing each means four opens of one scanner, and opening two
    /// nodes of the same device concurrently can wedge the port.
    ///
    /// Observed on hardware 2026-08-26; see
    /// docs/wire_captures/2026-08-26/bc75xlt-compatibility.md.
    #[test]
    fn four_nodes_of_one_scanner_collapse_to_one_candidate() {
        let ports = vec![
            usb_port(
                "/dev/cu.usbserial-020D43D8",
                0x10C4,
                0xEA60,
                Some("020D43D8"),
            ),
            usb_port(
                "/dev/tty.usbserial-020D43D8",
                0x10C4,
                0xEA60,
                Some("020D43D8"),
            ),
            usb_port("/dev/cu.SLAB_USBtoUART", 0x10C4, 0xEA60, Some("020D43D8")),
            usb_port("/dev/tty.SLAB_USBtoUART", 0x10C4, 0xEA60, Some("020D43D8")),
        ];
        let scored: Vec<(i32, String)> = ports
            .iter()
            .filter_map(|p| score_port(p).map(|s| (s, p.port_name.clone())))
            .collect();
        let deduped = dedupe_physical_devices(scored, &ports);

        assert_eq!(deduped.len(), 1, "one physical scanner, one candidate");
        assert_eq!(
            deduped[0].1, "/dev/cu.usbserial-020D43D8",
            "the surviving node must be the call-up one: tty.* blocks on open \
             waiting for carrier detect, which a scanner never asserts"
        );
    }

    /// Two genuinely different devices must not be collapsed.
    #[test]
    fn distinct_devices_are_not_deduped() {
        let ports = vec![
            usb_port("/dev/cu.usbserial-AAAA", 0x10C4, 0xEA60, Some("AAAA")),
            usb_port("/dev/cu.usbserial-BBBB", 0x10C4, 0xEA60, Some("BBBB")),
        ];
        let scored: Vec<(i32, String)> = ports
            .iter()
            .filter_map(|p| score_port(p).map(|s| (s, p.port_name.clone())))
            .collect();
        assert_eq!(dedupe_physical_devices(scored, &ports).len(), 2);
    }

    /// A device with no serial number cannot be collapsed safely -- two
    /// identical adapters would be indistinguishable -- so all are kept.
    #[test]
    fn devices_without_serials_are_all_kept() {
        let ports = vec![
            usb_port("/dev/cu.usbserial-1", 0x10C4, 0xEA60, None),
            usb_port("/dev/cu.usbserial-2", 0x10C4, 0xEA60, None),
        ];
        let scored: Vec<(i32, String)> = ports
            .iter()
            .filter_map(|p| score_port(p).map(|s| (s, p.port_name.clone())))
            .collect();
        assert_eq!(dedupe_physical_devices(scored, &ports).len(), 2);
    }

    /// tty.* must score below its cu.* sibling. Linux names (ttyUSB0/ttyACM0)
    /// carry no `/dev/tty.` prefix and must be unaffected.
    #[test]
    fn tty_nodes_score_below_their_cu_siblings() {
        let cu = usb_port("/dev/cu.usbserial-X", 0x10C4, 0xEA60, Some("X"));
        let tty = usb_port("/dev/tty.usbserial-X", 0x10C4, 0xEA60, Some("X"));
        assert!(score_port(&cu) > score_port(&tty));

        let linux = usb_port("/dev/ttyUSB0", 0x10C4, 0xEA60, Some("X"));
        let linux_acm = usb_port("/dev/ttyACM0", 0x10C4, 0xEA60, Some("X"));
        assert_eq!(
            score_port(&linux),
            score_port(&linux_acm),
            "Linux device names must not be penalised by the macOS tty rule"
        );
    }

    /// BC75XLT is a supported model as of #400.
    #[test]
    fn bc75xlt_is_supported() {
        assert!(is_supported_model("BC75XLT"));
        assert!(is_supported_model("bc75xlt"));
        assert!(supported_models_list().contains("BC75XLT"));
    }

    /// Every allowlisted model must have a capability descriptor, or it
    /// silently inherits BC125AT memory constants via the fallback.
    #[test]
    fn every_allowlisted_model_has_capabilities() {
        for m in ACCEPTED_MDL_MODELS {
            assert!(
                crate::protocol::capabilities::ScannerCapabilities::for_model(m).is_some(),
                "{m} is allowlisted but has no capability descriptor"
            );
        }
    }

    #[test]
    fn cache_roundtrip_via_serde() {
        let cache = LastScannerCache {
            serial_number: "0001".to_string(),
            port_name: "/dev/cu.usbmodem14101".to_string(),
            model: "BC125AT".to_string(),
        };
        let json = serde_json::to_string(&cache).expect("serialize");
        let parsed: LastScannerCache = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.serial_number, "0001");
        assert_eq!(parsed.port_name, "/dev/cu.usbmodem14101");
        assert_eq!(parsed.model, "BC125AT");
    }

    #[test]
    fn malformed_cache_returns_none() {
        // Write garbage to the cache path and confirm load_last_scanner_cache
        // returns None instead of panicking. Uses test-mode default_data_dir.
        let path = last_scanner_cache_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, b"not json at all");
        assert!(load_last_scanner_cache().is_none());
        let _ = fs::remove_file(&path);
    }

    /// REGRESSION GUARD (#392): a catalogued PID must always outrank an
    /// uncatalogued Uniden device.
    ///
    /// `probe_known_scanner_via_usb` walks the bus in arbitrary order, so
    /// without an explicit rank a non-scanner Uniden peripheral (cordless
    /// base, dash cam) enumerated before the scanner would be returned
    /// instead of it. Widening detection is only safe while the known PID
    /// still wins.
    #[test]
    fn known_pid_outranks_unknown_uniden_pid() {
        let known = usb_candidate_rank(UNIDEN_VID, 0x0017).expect("known PID must be a candidate");
        let unknown =
            usb_candidate_rank(UNIDEN_VID, 0x00ff).expect("any Uniden VID must be a candidate");
        assert!(
            known < unknown,
            "a catalogued PID (rank {known}) must outrank an uncatalogued Uniden \
             device (rank {unknown}), or bus enumeration order decides which \
             device we open"
        );
    }

    /// Tier 1 is what makes a supported scanner on an uncatalogued PID
    /// discoverable on macOS at all. Pinning it so a future "tighten this
    /// back up" change has to confront #392 rather than silently restoring
    /// the "no scanner found" bug.
    #[test]
    fn uncatalogued_uniden_pid_is_still_a_candidate() {
        assert!(
            usb_candidate_rank(UNIDEN_VID, 0x00ff).is_some(),
            "an unknown PID on Uniden's vendor ID must be probed; the MDL reply \
             is what decides, not the PID table"
        );
    }

    /// The widening is scoped to Uniden's vendor ID. A random third-party
    /// device must never be opened and written to.
    #[test]
    fn non_uniden_vid_is_not_a_candidate() {
        assert!(
            usb_candidate_rank(0x05ac, 0x1234).is_none(),
            "a non-Uniden VID must not be a scanner candidate"
        );
    }

    #[test]
    fn accepted_models_includes_bc125at_family() {
        assert!(ACCEPTED_MDL_MODELS.contains(&"BC125AT"));
        assert!(ACCEPTED_MDL_MODELS.contains(&"BCT125AT"));
        assert!(ACCEPTED_MDL_MODELS.contains(&"UBC125XLT"));
    }

    #[test]
    fn trunking_scanners_are_not_accepted_models() {
        // BC346XT and friends are TrunkTracker units: systems/sites/groups and
        // dynamic memory, not the flat CIN,1..500 bank the whole memory-sync
        // path assumes. Accepting one here would let autodetect commit to a
        // port it cannot actually drive, replacing a clean rejection with 500
        // failing CIN round-trips. Adding a model here means the protocol
        // work landed first.
        for model in ["BC346XT", "BCD396XT", "BCD996XT", "BCT15X"] {
            assert!(
                !ACCEPTED_MDL_MODELS
                    .iter()
                    .any(|known| model.eq_ignore_ascii_case(known)),
                "{model} is a trunking scanner and must not be in ACCEPTED_MDL_MODELS"
            );
        }
    }

    #[test]
    fn unsupported_model_is_distinct_from_no_reply() {
        // REGRESSION GUARD: probe_mdl_on_port used to return Option<String>,
        // collapsing "a Uniden answered with a model we don't drive" into the
        // same None as "nothing answered". That made an unsupported scanner
        // report the generic "no scanner found", which reads as a broken cable
        // rather than unsupported hardware. Keep the arms distinguishable.
        assert!(matches!(MdlProbe::Unsupported, MdlProbe::Unsupported));
        assert!(matches!(MdlProbe::NoReply, MdlProbe::NoReply));
        assert!(!matches!(MdlProbe::Unsupported, MdlProbe::NoReply));
        // Same argument one layer down: "the OS refused the port" is evidence
        // the scanner is attached, and folding it into NoReply threw that away.
        // Observed 2026-08-27 -- two CP210x drivers claiming one device made
        // every node unopenable, and detection reported an empty USB bus.
        assert!(matches!(MdlProbe::OpenFailed, MdlProbe::OpenFailed));
        assert!(!matches!(MdlProbe::OpenFailed, MdlProbe::NoReply));
    }
}
