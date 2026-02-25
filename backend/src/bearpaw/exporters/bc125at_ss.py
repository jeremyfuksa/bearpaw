from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from bearpaw.protocol.bc125at import BC125ATDriver


MAX_CHANNELS = 500

BACKLIGHT_MAP = {
    "AO": "On",
    "AF": "Off",
    "KY": "Key",
    "SQ": "Squelch",
    "KS": "K+S",
}

PRIORITY_MAP = {
    "0": "Off",
    "1": "On",
    "2": "Plus",
    "3": "DND",
}

CC_MODE_MAP = {
    "0": "Off",
    "1": "Pri",
    "2": "DND",
}

SERVICE_NAMES = [
    "Police",
    "Fire/Emergency",
    "HAM Radio",
    "Marine",
    "Railroad",
    "Civil Air",
    "Military Air",
    "CB Radio",
    "FRS/GMRS/MURS",
    "Racing",
]


def _split_response(response: str) -> List[str]:
    parts = [part.strip() for part in response.strip().split(",")]
    if parts and parts[0].isalpha():
        parts = parts[1:]
    while parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def _flags_to_bools(flags: str) -> List[bool]:
    return [ch == "0" for ch in flags.strip()]


def _on_off(value: str) -> str:
    return "On" if value == "1" else "Off"


def _format_modulation(value: str) -> str:
    if value.upper() == "AUTO":
        return "Auto"
    return value.upper() if value else "Auto"


def _ctcss_code_to_tone(code: int) -> Optional[float]:
    mapping = {
        64: 67.0,
        65: 69.3,
        66: 71.9,
        67: 74.4,
        68: 77.0,
        69: 79.7,
        70: 82.5,
        71: 85.4,
        72: 88.5,
        73: 91.5,
        74: 94.8,
        75: 97.4,
        76: 100.0,
        77: 103.5,
        78: 107.2,
        79: 110.9,
        80: 114.8,
        81: 118.8,
        82: 123.0,
        83: 127.3,
        84: 131.8,
        85: 136.5,
        86: 141.3,
        87: 146.2,
        88: 151.4,
        89: 156.7,
        90: 159.8,
        91: 162.2,
        92: 165.5,
        93: 167.9,
        94: 171.3,
        95: 173.8,
        96: 177.3,
        97: 179.9,
        98: 183.5,
        99: 186.2,
        100: 189.9,
        101: 192.8,
        102: 196.6,
        103: 199.5,
        104: 203.5,
        105: 206.5,
        106: 210.7,
        107: 218.1,
        108: 225.7,
        109: 229.1,
        110: 233.6,
        111: 241.8,
        112: 250.3,
        113: 254.1,
    }
    return mapping.get(code)


def _dcs_code_to_string(code: int) -> str:
    mapping = {
        128: 23,
        129: 25,
        130: 26,
        131: 31,
        132: 32,
        133: 36,
        134: 43,
        135: 47,
        136: 51,
        137: 53,
        138: 54,
        139: 65,
        140: 71,
        141: 72,
        142: 73,
        143: 74,
        144: 114,
        145: 115,
        146: 116,
        147: 122,
        148: 125,
        149: 131,
        150: 132,
        151: 134,
        152: 143,
        153: 145,
        154: 152,
        155: 155,
        156: 156,
        157: 162,
        158: 165,
        159: 172,
        160: 174,
        161: 205,
        162: 212,
        163: 223,
        164: 225,
        165: 226,
        166: 243,
        167: 244,
        168: 245,
        169: 246,
        170: 251,
        171: 252,
        173: 261,
        174: 263,
        175: 265,
        176: 266,
        177: 271,
        178: 274,
        179: 306,
        180: 311,
        181: 315,
        182: 325,
        183: 331,
        184: 332,
        185: 343,
        186: 346,
        187: 351,
        188: 356,
        189: 364,
        190: 365,
        191: 371,
        192: 411,
        193: 412,
        194: 413,
        195: 423,
        196: 431,
        197: 432,
        198: 445,
        199: 446,
        200: 452,
        201: 454,
        202: 455,
        203: 462,
        204: 464,
        205: 465,
        206: 466,
        207: 503,
        208: 506,
        209: 516,
        210: 523,
        211: 526,
        212: 532,
        213: 546,
        214: 565,
        215: 606,
        216: 612,
        217: 624,
        218: 627,
        219: 631,
        220: 632,
        221: 654,
        222: 662,
        223: 664,
        224: 703,
        225: 712,
        226: 723,
        227: 731,
        228: 732,
        229: 734,
        230: 743,
        231: 754,
    }
    value = mapping.get(code)
    return f"DCS {value:03d}" if value is not None else "Off"


def _ctcss_dcs_to_string(code: str) -> str:
    if not code:
        return "Off"
    if code == "0":
        return "Off"
    if code == "127":
        return "Srch"
    if code == "240":
        return "Off"
    try:
        value = int(code)
    except ValueError:
        return "Off"
    if 64 <= value <= 113:
        tone = _ctcss_code_to_tone(value)
        return f"{tone:.1f}" if tone is not None else "Off"
    if 128 <= value <= 231:
        return _dcs_code_to_string(value)
    return "Off"


@dataclass
class CustomSearchRange:
    index: int
    lower_hz: int
    upper_hz: int


@dataclass
class ChannelSnapshot:
    index: int
    name: str
    frequency_hz: int
    modulation: str
    tone: str
    lockout: str
    delay: str
    priority: str


async def export_bc125at_ss(driver: BC125ATDriver, region: str = "USA") -> str:
    await driver.begin_memory_sync()
    try:
        backlight = _split_response(await driver.send_program_command("BLT"))[0]
        beep_level, key_lock = _split_response(await driver.send_program_command("KBP"))
        charge_time = _split_response(await driver.send_program_command("BSV"))[0]
        priority_mode = _split_response(await driver.send_program_command("PRI"))[0]
        scan_flags = _split_response(await driver.send_program_command("SCG"))[0]
        search_delay, search_code = _split_response(await driver.send_program_command("SCO"))
        cc_mode, cc_beep, cc_light, cc_bands, cc_lockout = _split_response(
            await driver.send_program_command("CLC")
        )
        service_flags = _split_response(await driver.send_program_command("SSG"))[0]
        custom_flags = _split_response(await driver.send_program_command("CSG"))[0]
        wx_pri = _split_response(await driver.send_program_command("WXS"))[0]
        contrast = _split_response(await driver.send_program_command("CNT"))[0]
        volume = _split_response(await driver.send_program_command("VOL"))[0]
        squelch = _split_response(await driver.send_program_command("SQL"))[0]

        custom_ranges: List[CustomSearchRange] = []
        for idx in range(1, 11):
            range_parts = _split_response(await driver.send_program_command(f"CSP,{idx}"))
            if len(range_parts) >= 3:
                lower_hz = int(range_parts[1]) * 100
                upper_hz = int(range_parts[2]) * 100
            else:
                lower_hz = 0
                upper_hz = 0
            custom_ranges.append(CustomSearchRange(idx, lower_hz, upper_hz))

        channels: List[ChannelSnapshot] = []
        for idx in range(1, MAX_CHANNELS + 1):
            response = await driver.send_program_command(f"CIN,{idx}")
            parts = [part.strip() for part in response.split(",")]
            if parts and parts[0] == "CIN":
                parts = parts[1:]
            if parts and parts[0].isdigit():
                parts = parts[1:]
            name = parts[0] if len(parts) > 0 else ""
            freq_raw = parts[1] if len(parts) > 1 else "0"
            try:
                frequency_hz = int(freq_raw) * 100
            except ValueError:
                frequency_hz = 0
            modulation = _format_modulation(parts[2] if len(parts) > 2 else "Auto")
            tone = _ctcss_dcs_to_string(parts[3] if len(parts) > 3 else "0")
            delay = parts[4] if len(parts) > 4 else "2"
            lockout = _on_off(parts[5] if len(parts) > 5 else "0")
            priority = _on_off(parts[6] if len(parts) > 6 else "0")
            channels.append(
                ChannelSnapshot(
                    index=idx,
                    name=name,
                    frequency_hz=frequency_hz,
                    modulation=modulation,
                    tone=tone,
                    lockout=lockout,
                    delay=delay,
                    priority=priority,
                )
            )
    finally:
        await driver.end_memory_sync()

    lines: List[str] = []

    misc_backlight = BACKLIGHT_MAP.get(backlight, "Off")
    misc_beep = "Auto" if beep_level == "0" else "Off" if beep_level == "99" else beep_level
    misc_key_lock = "On" if key_lock == "1" else "Off"
    lines.append(
        "\t".join(
            [
                "Misc",
                misc_backlight,
                misc_beep,
                misc_key_lock,
                contrast,
                volume,
                squelch,
                charge_time,
                region,
            ]
        )
    )

    lines.append("\t".join(["Priority", PRIORITY_MAP.get(priority_mode, "Off")]))
    lines.append("\t".join(["WxPri", _on_off(wx_pri)]))

    service_enabled = _flags_to_bools(service_flags)
    for idx, name in enumerate(SERVICE_NAMES, start=1):
        enabled = "On" if service_enabled[idx - 1] else "Off"
        lines.append("\t".join(["Service", str(idx), name, enabled]))

    custom_enabled = _flags_to_bools(custom_flags)
    for idx, custom_range in enumerate(custom_ranges, start=1):
        enabled = "On" if custom_enabled[idx - 1] else "Off"
        lines.append(
            "\t".join(
                [
                    "Custom",
                    str(idx),
                    f"Search Bnak{idx}",
                    str(custom_range.lower_hz),
                    str(custom_range.upper_hz),
                    enabled,
                ]
            )
        )

    lines.append(
        "\t".join(
            [
                "CloseCall",
                CC_MODE_MAP.get(cc_mode, "Off"),
                _on_off(cc_beep),
                _on_off(cc_light),
                _on_off(cc_lockout),
            ]
        )
    )

    cc_band_flags = _flags_to_bools(cc_bands)
    lines.append(
        "\t".join(["CloseCallBands", *("On" if flag else "Off" for flag in cc_band_flags)])
    )

    lines.append("\t".join(["GeneralSearch", search_delay, _on_off(search_code)]))

    scan_enabled = _flags_to_bools(scan_flags)
    for idx, enabled in enumerate(scan_enabled, start=1):
        lines.append("\t".join(["Conventional", str(idx), f"Bank {idx}", "On" if enabled else "Off"]))

    for channel in channels:
        lines.append(
            "\t".join(
                [
                    "C-Freq",
                    str(channel.index),
                    channel.name,
                    str(channel.frequency_hz),
                    channel.modulation,
                    channel.tone,
                    channel.lockout,
                    channel.delay,
                    channel.priority,
                ]
            )
        )

    return "\n".join(lines) + "\n"
