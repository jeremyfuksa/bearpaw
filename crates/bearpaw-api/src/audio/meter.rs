//! How loud each host input is, for finding the scanner's input (#930).
//!
//! Setup opens every input at once and compares them before and after the
//! scanner's squelch is opened: the input that gets loud is the scanner's.
//! This is a short measurement, not the recording stream; it keeps no samples.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;

use super::device_id;

/// Floor for an input that delivered only digital silence, so a silent input
/// still has a finite level to compare against.
const SILENCE_DBFS: f64 = -120.0;

/// Peak and RMS of normalized samples (-1.0..=1.0) since the last reset.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Level {
    sum_squares: f64,
    samples: u64,
    peak: f32,
}

impl Level {
    pub fn add(&mut self, sample: f32) {
        if !sample.is_finite() {
            return;
        }
        let sample = sample.clamp(-1.0, 1.0);
        self.peak = self.peak.max(sample.abs());
        self.sum_squares += f64::from(sample) * f64::from(sample);
        self.samples += 1;
    }

    /// RMS in dBFS, or `None` when no samples arrived at all. An input that
    /// delivered nothing is not the same as an input that heard silence.
    pub fn rms_dbfs(&self) -> Option<f64> {
        if self.samples == 0 {
            return None;
        }
        let rms = (self.sum_squares / self.samples as f64).sqrt();
        Some((20.0 * rms.log10()).max(SILENCE_DBFS))
    }

    /// Largest absolute sample, 0.0..=1.0.
    pub fn peak(&self) -> f32 {
        self.peak
    }
}

/// One input's level over a measurement window.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InputLevel {
    /// Same id as `GET /api/v1/audio/devices`.
    pub id: String,
    pub name: String,
    pub rms_dbfs: Option<f64>,
    pub peak: f32,
}

/// Every input the host lists, open and metering.
///
/// `cpal::Stream` is not `Send` on every platform, so the meter must be
/// created, read and dropped on one thread. Dropping it closes every stream.
pub struct InputMeter {
    inputs: Vec<(String, String, Arc<Mutex<Level>>, cpal::Stream)>,
}

impl InputMeter {
    /// Open every input with its default configuration. An input that fails
    /// to open is logged and left out; the others still meter.
    pub fn open_all() -> Result<Self, String> {
        let host = cpal::default_host();
        let devices = host
            .input_devices()
            .map_err(|e| format!("audio_enumerate_failed: {e}"))?;
        let mut inputs = Vec::new();
        for (index, device) in devices.enumerate() {
            match open(&device) {
                Ok((name, level, stream)) => {
                    inputs.push((device_id(index, &name), name, level, stream))
                }
                Err(error) => tracing::warn!(index, %error, "input not metered"),
            }
        }
        Ok(Self { inputs })
    }

    /// Each input's level since the last call, then start again from zero.
    pub fn take(&self) -> Vec<InputLevel> {
        self.inputs
            .iter()
            .map(|(id, name, level, _)| {
                let level = std::mem::take(&mut *level.lock().unwrap());
                InputLevel {
                    id: id.clone(),
                    name: name.clone(),
                    rms_dbfs: level.rms_dbfs(),
                    peak: level.peak(),
                }
            })
            .collect()
    }
}

fn open(device: &cpal::Device) -> Result<(String, Arc<Mutex<Level>>, cpal::Stream), String> {
    let (name, config) = super::input_config(device)?;
    let level = Arc::new(Mutex::new(Level::default()));
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(device, &config, level.clone()),
        SampleFormat::I16 => build::<i16>(device, &config, level.clone()),
        SampleFormat::U16 => build::<u16>(device, &config, level.clone()),
        SampleFormat::I32 => build::<i32>(device, &config, level.clone()),
        other => Err(format!("unsupported sample format {other}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((name, level, stream))
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    level: Arc<Mutex<Level>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mut level = level.lock().unwrap();
                for &sample in data {
                    level.add(sample.to_sample::<f32>());
                }
            },
            |error| tracing::warn!(%error, "input stream error while metering"),
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::Sample;

    fn level_of(samples: &[f32]) -> Level {
        let mut level = Level::default();
        samples.iter().for_each(|&s| level.add(s));
        level
    }

    #[test]
    fn no_samples_has_no_level() {
        assert_eq!(Level::default().rms_dbfs(), None);
        assert_eq!(Level::default().peak(), 0.0);
    }

    #[test]
    fn digital_silence_reads_as_the_floor_not_minus_infinity() {
        assert_eq!(level_of(&[0.0; 64]).rms_dbfs(), Some(SILENCE_DBFS));
    }

    #[test]
    fn a_full_scale_square_wave_is_zero_dbfs() {
        let level = level_of(&[1.0, -1.0, 1.0, -1.0]);
        assert!(level.rms_dbfs().unwrap().abs() < 1e-9);
        assert_eq!(level.peak(), 1.0);
    }

    #[test]
    fn half_scale_is_about_minus_six_dbfs() {
        let db = level_of(&[0.5, -0.5]).rms_dbfs().unwrap();
        assert!((db - -6.0206).abs() < 1e-3, "{db}");
    }

    #[test]
    fn peak_is_the_largest_magnitude_either_sign() {
        assert_eq!(level_of(&[0.1, -0.8, 0.3]).peak(), 0.8);
    }

    #[test]
    fn non_finite_samples_are_ignored_and_over_range_is_clamped() {
        let level = level_of(&[f32::NAN, f32::INFINITY, 2.0]);
        assert_eq!(level.peak(), 1.0);
        assert!(level.rms_dbfs().unwrap().abs() < 1e-9);
    }

    #[test]
    fn integer_formats_normalize_through_cpal() {
        let mut level = Level::default();
        level.add(i16::MIN.to_sample::<f32>());
        level.add(u16::MAX.to_sample::<f32>());
        assert!(level.peak() > 0.99);
    }

    /// Opens the real inputs on this machine for half a second. Needs
    /// microphone access, so it never runs in CI:
    /// `cargo test -p bearpaw-api --lib meter -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn meters_this_machines_inputs() {
        let meter = InputMeter::open_all().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        for input in meter.take() {
            println!("{input:?}");
            assert!(input.id.contains(':'));
        }
    }
}
