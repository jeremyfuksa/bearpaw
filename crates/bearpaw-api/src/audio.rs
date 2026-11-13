//! Host-side audio discovery, independent of the scanner's USB control link.
//! Audio requires a cable from the scanner's headphone jack to a host input.
//! Discovery opens no streams; `meter` opens them briefly to measure levels.
//! Nothing here persists a device selection.

use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

pub mod meter;
pub mod segment;
pub mod wav;

/// A snapshot of an input and the configuration CPAL would open by default.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct AudioDeviceInfo {
    /// Enumeration index plus name; invalidated by enumeration/topology changes.
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
}

/// Query the platform's default host (CoreAudio, WASAPI or ALSA).
///
/// Host enumeration failures fail the query; unreadable devices are logged and
/// skipped so other inputs remain available. No audio stream is opened.
pub fn list_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("audio_enumerate_failed: {e}"))?;
    Ok(collect_devices(devices.map(|device| {
        let name = device
            .name()
            .map_err(|e| format!("audio_device_name_failed: {e}"))?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("audio_device_config_failed: {name}: {e}"))?;
        Ok(AudioDeviceInfo {
            id: String::new(),
            name,
            channels: config.channels(),
            sample_rate: config.sample_rate().0,
        })
    })))
}

/// An input's id: enumeration index plus name. Discovery and the meter must
/// agree on it, so the setup flow can name the input it found.
fn device_id(index: usize, name: &str) -> String {
    format!("{index}:{name}")
}

fn collect_devices(
    devices: impl Iterator<Item = Result<AudioDeviceInfo, String>>,
) -> Vec<AudioDeviceInfo> {
    let mut devices: Vec<_> = devices
        .enumerate()
        .filter_map(|(index, result)| match result {
            Ok(mut device) => {
                device.id = device_id(index, &device.name);
                Some(device)
            }
            Err(error) => {
                tracing::warn!(index, %error, "skipping unavailable audio input");
                None
            }
        })
        .collect();
    devices.sort_by(|a, b| a.name.cmp(&b.name));
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(name: &str) -> AudioDeviceInfo {
        AudioDeviceInfo {
            id: String::new(),
            name: name.into(),
            channels: 2,
            sample_rate: 48_000,
        }
    }

    #[test]
    fn discovery_sorts_without_collapsing_duplicate_names() {
        let devices = collect_devices(
            [Ok(device("USB")), Ok(device("Built-in")), Ok(device("USB"))].into_iter(),
        );
        assert_eq!(
            devices.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["1:Built-in", "0:USB", "2:USB"]
        );
    }

    #[test]
    fn failed_devices_are_skipped_without_renumbering_working_inputs() {
        assert!(collect_devices(std::iter::empty()).is_empty());
        let devices = collect_devices(
            [
                Err("name failed".into()),
                Ok(device("USB")),
                Err("config failed".into()),
                Ok(device("USB")),
            ]
            .into_iter(),
        );
        assert_eq!(
            devices.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["1:USB", "3:USB"]
        );
        assert!(collect_devices([Err("unavailable".into())].into_iter()).is_empty());
    }
}
