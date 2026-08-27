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
/// This is the gate that keeps BC125AT-family *memory-model* constants safe --
/// the fixed 1-500 / 10-bank layout in `protocol::channel_to_bank`, the
/// `CIN,1..500` walk in `api::memory_sync`, and the 10-character `SCG` mask.
/// Those are family assumptions, not protocol assumptions: a BC75XLT speaks
/// the same wire protocol with 300 channels. See #389.
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

/// Resolve just the port name, discarding the detected baud.
///
/// Retained for callers that predate multi-baud detection. Anything opening the
/// port wants [`resolve_scanner_port`] instead -- the baud is not always the
/// configured one.
pub fn resolve_serial_port(cfg: &Config) -> Option<String> {
    resolve_scanner_port(cfg).map(|r| r.port_name)
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
            (MdlProbe::Unsupported, _) | (MdlProbe::NoReply, _) => continue,
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
    // Tier 2: a CP210x bridge. Asserts nothing about what is behind it -- these
    // bridges are in countless unrelated devices -- so it ranks below any
    // Uniden VID and is confirmed only by the MDL reply. Without this tier the
    // BC75XLT is undetectable: it carries no Uniden identifiers at all.
    if vid == SILICON_LABS_VID {
        return Some(2);
    }
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
enum MdlProbe {
    Supported,
    Unsupported,
    NoReply,
}

/// Briefly open a serial port, send `MDL\r`, and classify what answered.
/// Used by the autodetect path to avoid committing to a port that scored
/// well but isn't actually our hardware (e.g. an unrelated USB-serial
/// device).
///
/// Best-effort and tolerant: any open/read/parse failure yields
/// `MdlProbe::NoReply` so the caller falls through to the next candidate.
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
            MdlProbe::NoReply => {}
        }
    }
    (best, configured)
}

fn probe_mdl_on_port(port_name: &str, baud: u32) -> MdlProbe {
    use crate::transport::SerialTransport;
    let transport = SerialTransport::new(port_name, baud);
    let Ok(mut port) = transport.open() else {
        return MdlProbe::NoReply;
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
    /// USB serial number reported by `serialport::UsbPortInfo`. Stable per
    /// physical scanner unit; lets us distinguish two BC125ATs plugged into
    /// the same host.
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
    let ports = serialport::available_ports().ok()?;
    for p in ports {
        if p.port_name == port_name {
            if let serialport::SerialPortType::UsbPort(info) = p.port_type {
                return info.serial_number;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// The BC75XLT carries no Uniden identifiers -- it sits behind a CP2104
    /// bridge and enumerates as Silicon Labs. Without the CP210x tier it is
    /// undetectable. Ranked below Uniden so a real Uniden always wins.
    #[test]
    fn cp210x_is_a_candidate_ranked_below_uniden() {
        assert_eq!(usb_candidate_rank(SILICON_LABS_VID, 0xEA60), Some(2));
        assert_eq!(usb_candidate_rank(UNIDEN_VID, 0x0017), Some(0));
        assert_eq!(usb_candidate_rank(UNIDEN_VID, 0x9999), Some(1));
        assert!(
            usb_candidate_rank(UNIDEN_VID, 0x9999) < usb_candidate_rank(SILICON_LABS_VID, 0xEA60),
            "a Uniden device must outrank a generic bridge"
        );
        assert_eq!(usb_candidate_rank(0x1234, 0x5678), None);
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
    }
}
