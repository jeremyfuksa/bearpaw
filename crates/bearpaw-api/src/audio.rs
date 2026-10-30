//! Host-side audio discovery, independent of the scanner's USB control link.
//! Audio requires a cable from the scanner's headphone jack to a host input.
//! This module does not open streams or persist device selections.

use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

/// A snapshot of an input's name and default format, not a stable device ID.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
}

/// Query the platform's default host (CoreAudio, WASAPI or ALSA).
///
/// Errors, including unreadable device metadata, fail the query rather than
/// masquerading as no inputs or a complete list. No audio stream is opened.
pub fn list_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("audio_enumerate_failed: {e}"))?;
    collect_devices(devices.map(|device| {
        let name = device
            .name()
            .map_err(|e| format!("audio_device_name_failed: {e}"))?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("audio_device_config_failed: {name}: {e}"))?;
        Ok(AudioDeviceInfo {
            name,
            channels: config.channels(),
            sample_rate: config.sample_rate().0,
        })
    }))
}

fn collect_devices(
    devices: impl Iterator<Item = Result<AudioDeviceInfo, String>>,
) -> Result<Vec<AudioDeviceInfo>, String> {
    let mut devices = devices.collect::<Result<Vec<_>, _>>()?;
    devices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(devices)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(name: &str) -> AudioDeviceInfo {
        AudioDeviceInfo {
            name: name.into(),
            channels: 2,
            sample_rate: 48_000,
        }
    }

    #[test]
    fn discovery_sorts_without_collapsing_duplicate_names() {
        let devices = collect_devices(
            [Ok(device("USB")), Ok(device("Built-in")), Ok(device("USB"))].into_iter(),
        )
        .unwrap();
        assert_eq!(devices, [device("Built-in"), device("USB"), device("USB")]);
    }

    #[test]
    fn an_empty_host_is_success_but_a_failed_device_is_not_a_partial_list() {
        assert!(collect_devices(std::iter::empty()).unwrap().is_empty());
        assert_eq!(
            collect_devices([Ok(device("USB")), Err("unavailable".into())].into_iter()),
            Err("unavailable".into())
        );
    }
}
