//! Hardware-free conversion of interleaved device samples to mono 16 kHz f32.
//! Ported from the preserved capture implementation, without opening a stream.
//! Linear interpolation is not an anti-alias filter: content above 8 kHz can
//! alias when downsampling. Filtered conversion is a separate quality decision.

use std::num::{NonZeroU16, NonZeroU32};

use cpal::{FromSample, Sample, SizedSample};
use thiserror::Error;

use super::wav::SAMPLE_RATE;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConversionError {
    #[error("input block ends inside an interleaved frame")]
    IncompleteFrame,
    #[error("non-finite device sample")]
    NonFinite,
}

/// One continuous input format. Create a new converter after a device restart,
/// format change or input gap; never interpolate across missing audio. The
/// caller must also tell downstream segmentation/storage about discontinuities.
/// State is constant-size; no device, clock, queue or clip boundary lives here.
pub struct FrameConverter {
    channels: usize,
    input_rate: u64,
    // Distance from the previous input frame to the next output, in units of
    // 1 / SAMPLE_RATE input frames. Integer phase avoids long-run float drift.
    next: u64,
    previous: Option<f32>,
}

impl FrameConverter {
    /// Zero rates/channel counts are unrepresentable. Output is always one
    /// normalized f32 sample per mono frame at `wav::SAMPLE_RATE` (16 kHz).
    pub fn new(input_rate: NonZeroU32, channels: NonZeroU16) -> Self {
        Self {
            channels: usize::from(channels.get()),
            input_rate: u64::from(input_rate.get()),
            next: 0,
            previous: None,
        }
    }

    /// Append converted frames to caller-owned output. Blocks must contain whole
    /// interleaved frames; empty blocks do nothing. Errors leave both state and
    /// output unchanged. Samples use CPAL's signed/unsigned normalization, then
    /// channels are equally averaged and finite over-range mixes clipped.
    ///
    /// The first frame emits immediately at time zero. Later outputs interpolate
    /// only between available input frames, including across blocks. No invented
    /// tail is flushed: output timestamps never exceed the last input timestamp.
    pub fn push<T>(&mut self, input: &[T], output: &mut Vec<f32>) -> Result<(), ConversionError>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        if !input.len().is_multiple_of(self.channels) {
            return Err(ConversionError::IncompleteFrame);
        }
        if input.iter().any(|s| !f32::from_sample(*s).is_finite()) {
            return Err(ConversionError::NonFinite);
        }
        let rate = u64::from(SAMPLE_RATE);
        for frame in input.chunks_exact(self.channels) {
            // f64 summation avoids overflow for finite, over-range f32 input.
            let sum: f64 = frame.iter().map(|s| f64::from(f32::from_sample(*s))).sum();
            let mono = (sum / self.channels as f64).clamp(-1.0, 1.0) as f32;
            if let Some(previous) = self.previous {
                while self.next <= rate {
                    let value = if self.next == rate {
                        mono
                    } else {
                        previous + (mono - previous) * (self.next as f32 / rate as f32)
                    };
                    output.push(value);
                    self.next += self.input_rate;
                }
                self.next -= rate;
            } else {
                output.push(mono);
                self.next = self.input_rate;
            }
            self.previous = Some(mono);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn converter(rate: u32, channels: u16) -> FrameConverter {
        FrameConverter::new(rate.try_into().unwrap(), channels.try_into().unwrap())
    }

    #[test]
    fn native_mono_is_exact_and_appends_without_replacing_output() {
        let mut out = vec![0.75];
        converter(SAMPLE_RATE, 1)
            .push(&[-1.0_f32, 0.25, 1.0], &mut out)
            .unwrap();
        assert_eq!(out, [0.75, -1.0, 0.25, 1.0]);
    }

    #[test]
    fn mixes_all_channels_equally_and_clips_only_the_mix() {
        let mut out = Vec::new();
        converter(SAMPLE_RATE, 3)
            .push(
                &[1.0_f32, -1.0, 0.75, f32::MAX, f32::MAX, f32::MAX],
                &mut out,
            )
            .unwrap();
        assert_eq!(out, [0.25, 1.0]);
        let mut stereo = Vec::new();
        converter(SAMPLE_RATE, 2)
            .push(&[1.0_f32, -1.0, 0.5, 0.5], &mut stereo)
            .unwrap();
        assert_eq!(stereo, [0.0, 0.5]);
    }

    #[test]
    fn normalizes_signed_and_unsigned_device_formats() {
        let mut out = Vec::new();
        converter(SAMPLE_RATE, 1)
            .push(&[i16::MIN, 0, 16384], &mut out)
            .unwrap();
        converter(SAMPLE_RATE, 1)
            .push(&[0_u16, 32768, 49152], &mut out)
            .unwrap();
        converter(SAMPLE_RATE, 1)
            .push(&[i32::MIN, 0, 1073741824], &mut out)
            .unwrap();
        assert_eq!(out, [-1.0, 0.0, 0.5, -1.0, 0.0, 0.5, -1.0, 0.0, 0.5]);
    }

    #[test]
    fn interpolates_upsampling_and_selects_exact_downsampling_positions() {
        let mut out = Vec::new();
        converter(8_000, 1)
            .push(&[0.0_f32, 1.0, 0.0], &mut out)
            .unwrap();
        assert_eq!(out, [0.0, 0.5, 1.0, 0.5, 0.0]);
        out.clear();
        converter(48_000, 1)
            .push(&[0.0_f32, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], &mut out)
            .unwrap();
        assert_eq!(out, [0.0, 0.3, 0.6]);
    }

    #[test]
    fn fractional_ratio_interpolates_instead_of_rounding_input_positions() {
        let mut out = Vec::new();
        converter(24_000, 1)
            .push(&[0.0_f32, 0.25, 0.5, 0.75], &mut out)
            .unwrap();
        assert_eq!(out, [0.0, 0.375, 0.75]);
    }

    #[test]
    fn callback_boundaries_and_empty_blocks_do_not_change_samples_or_duration() {
        for rate in [8_000, 16_000, 44_100, 48_000, 96_000] {
            let input: Vec<f32> = (0..rate)
                .flat_map(|i| {
                    let s = (i as f32 * 0.01).sin();
                    [s, s * 0.5]
                })
                .collect();
            let mut whole = Vec::new();
            converter(rate, 2).push(&input, &mut whole).unwrap();
            // Includes every split position within a resampling phase cycle.
            for frames in [1, 7, 127, 512] {
                let mut c = converter(rate, 2);
                let mut split = Vec::new();
                for block in input.chunks(frames * 2) {
                    c.push::<f32>(&[], &mut split).unwrap();
                    c.push(block, &mut split).unwrap();
                }
                assert_eq!(split, whole, "rate {rate}, block {frames}");
            }
            let expected = (u64::from(rate - 1) * u64::from(SAMPLE_RATE)) / u64::from(rate) + 1;
            assert_eq!(whole.len() as u64, expected);
            assert!((whole.len() as i64 - i64::from(SAMPLE_RATE)).abs() <= 1);
        }
    }

    #[test]
    fn converted_frames_feed_existing_segmenter_and_wav_writer() {
        use super::super::{segment::Segmenter, wav::ClipWriter};

        let mut frames = Vec::new();
        converter(48_000, 2)
            .push(&vec![0.5_f32; 48_000 * 2], &mut frames)
            .unwrap();
        let mut segmenter = Segmenter::new(SAMPLE_RATE.try_into().unwrap(), 0, 1);
        segmenter.open().unwrap();
        segmenter.push_frames(&frames);
        let boundary = segmenter.close().unwrap();
        assert_eq!(boundary.duration, std::time::Duration::from_secs(1));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("converted.wav");
        let mut writer = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        writer.append(&frames).unwrap();
        writer.finalize(&boundary).unwrap();
        let mut reader = hound::WavReader::open(path).unwrap();
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.duration(), SAMPLE_RATE);
        assert!(reader.samples::<i16>().all(|s| s.unwrap() == 16383));
    }

    #[test]
    fn invalid_blocks_do_not_mutate_state_or_output() {
        let mut c = converter(8_000, 2);
        let mut out = Vec::new();
        c.push(&[0.0_f32, 0.0], &mut out).unwrap();
        assert_eq!(
            c.push(&[0.5_f32], &mut out),
            Err(ConversionError::IncompleteFrame)
        );
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                c.push(&[1.0, 1.0, invalid, 0.0], &mut out),
                Err(ConversionError::NonFinite)
            );
            assert_eq!(out, [0.0]);
        }
        c.push(&[1.0_f32, 1.0], &mut out).unwrap();
        assert_eq!(out, [0.0, 0.5, 1.0]);
        let mut restarted = Vec::new();
        converter(8_000, 2)
            .push(&[-1.0_f32, -1.0], &mut restarted)
            .unwrap();
        assert_eq!(restarted, [-1.0]); // no interpolation across a restart
    }
}
