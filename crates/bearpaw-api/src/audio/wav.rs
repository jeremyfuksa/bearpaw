//! Disk staging only: no capture, segmentation, naming or directory policy.
//! Mono 16-bit PCM at 16 kHz suits narrowband radio and Whisper's native rate.
//! Capture must downmix/resample first; this writer never guesses the format.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::Duration;

use hound::{SampleFormat, WavSpec, WavWriter};
use tempfile::NamedTempFile;

use super::segment::ClipBoundary;

/// Required input and output rate; one mono frame is one normalized `f32` sample.
pub const SAMPLE_RATE: u32 = 16_000;

// Stay below RIFF's 32-bit length limit, including header overhead.
const MAX_FRAMES: u64 = (u32::MAX as u64 - 44) / 2;

type WriteResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// One unpublished clip. Start on open, append returned pre-roll first, then
/// live frames. Finalize only for `Segmenter::close()`'s accepted boundary.
/// Drop to discard rejected, interrupted or abandoned clips (including on error).
///
/// Staging is beside the caller-supplied destination, with a `.part` suffix.
/// A crash or failed cleanup may leave recognizable staging debris, never a
/// partial final clip.
/// The caller must not recover `.part` files as completed recordings. Device
/// loss or dropped frames must abandon this writer, not finalize a partial clip.
pub struct ClipWriter {
    // Close the writer before deleting staging, including on Windows.
    writer: Option<WavWriter<BufWriter<File>>>,
    staging: NamedTempFile,
    destination: PathBuf,
    frames: u64,
}

impl ClipWriter {
    /// Create staging in an existing parent directory. The caller owns the final
    /// path, directory creation, naming and retention. Existing files are never
    /// overwritten. Input must be mono normalized `f32` at exactly 16 kHz.
    pub fn start(destination: &Path, sample_rate: u32, channels: u16) -> WriteResult<Self> {
        if sample_rate != SAMPLE_RATE || channels != 1 {
            return Err("expected mono frames at 16000 Hz".into());
        }
        let parent = destination.parent().filter(|p| !p.as_os_str().is_empty());
        let staging = tempfile::Builder::new()
            .prefix(".bearpaw-")
            .suffix(".part")
            .tempfile_in(parent.unwrap_or_else(|| Path::new(".")))?;
        let spec = WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let writer = WavWriter::new(BufWriter::new(staging.as_file().try_clone()?), spec)?;
        Ok(Self {
            writer: Some(writer),
            staging,
            destination: destination.to_owned(),
            frames: 0,
        })
    }

    /// Append ordered frames. Finite values clip to [-1, 1], then scale by
    /// `i16::MAX` and truncate toward zero, matching the preserved encoder.
    /// Any error poisons the clip: even a caller ignoring it cannot publish.
    pub fn append(&mut self, frames: &[f32]) -> WriteResult<()> {
        let result = self.append_inner(frames);
        if result.is_err() {
            self.writer.take();
        }
        result
    }

    fn append_inner(&mut self, frames: &[f32]) -> WriteResult<()> {
        if self.frames.saturating_add(frames.len() as u64) > MAX_FRAMES {
            return Err("clip exceeds PCM WAV size limit".into());
        }
        let writer = self.writer.as_mut().ok_or("clip write previously failed")?;
        for &frame in frames {
            if !frame.is_finite() {
                return Err("non-finite audio frame".into());
            }
            writer.write_sample((frame.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)?;
        }
        self.frames += frames.len() as u64;
        Ok(())
    }

    /// Validate the accepted boundary, finish the WAV header, flush and sync
    /// bytes, then atomically publish without replacing an existing destination.
    /// Uses a no-clobber rename (or atomic hard-link publication where unsupported).
    /// No fallible work follows publication. Directory-entry durability across
    /// power loss is not promised; a final path is either absent or complete.
    pub fn finalize(mut self, boundary: &ClipBoundary) -> WriteResult<()> {
        let rate = u64::from(SAMPLE_RATE);
        let duration = Duration::new(
            self.frames / rate,
            ((self.frames % rate) * 1_000_000_000 / rate) as u32,
        );
        if self.frames == 0
            || boundary.end_frame.checked_sub(boundary.start_frame) != Some(self.frames)
            || boundary.duration != duration
        {
            return Err("clip frames do not match accepted 16000 Hz boundary".into());
        }
        self.writer
            .take()
            .ok_or("clip write previously failed")?
            .finalize()?;
        self.staging.as_file().sync_all()?;
        // Do not return PersistError: it would keep the staging file alive.
        self.staging
            .persist_noclobber(&self.destination)
            .map_err(|error| error.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::segment::Segmenter;
    use std::num::NonZeroU32;

    fn segmenter(pre_roll: usize, minimum: u64) -> Segmenter {
        Segmenter::new(NonZeroU32::new(SAMPLE_RATE).unwrap(), pre_roll, minimum)
    }

    #[test]
    fn accepted_clip_roundtrips_pre_roll_then_live_frames_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let mut s = segmenter(2, 4);
        s.push_frames(&[0.9, -1.0, -0.5]);
        let mut w = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        w.append(&s.open().unwrap()).unwrap();
        for block in [&[0.0, 0.5][..], &[1.0, 2.0][..]] {
            s.push_frames(block);
            w.append(block).unwrap();
        }
        assert!(!path.exists());
        let boundary = s.close().unwrap();
        w.finalize(&boundary).unwrap();
        let mut reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(
            reader.spec(),
            WavSpec {
                channels: 1,
                sample_rate: SAMPLE_RATE,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            }
        );
        assert_eq!(reader.duration(), 6);
        assert_eq!(boundary.duration, Duration::from_micros(375));
        assert_eq!(
            reader
                .samples::<i16>()
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
            [-32767, -16383, 0, 16383, 32767, 32767]
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejected_and_abandoned_clips_leave_no_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = segmenter(0, 2);
        s.open().unwrap();
        let mut w = ClipWriter::start(&dir.path().join("rejected.wav"), SAMPLE_RATE, 1).unwrap();
        s.push_frames(&[0.5]);
        w.append(&[0.5]).unwrap();
        assert_eq!(s.close(), None);
        drop(w);
        let mut w = ClipWriter::start(&dir.path().join("lost.wav"), SAMPLE_RATE, 1).unwrap();
        w.append(&[0.5]).unwrap();
        drop(w); // device loss or shutdown without an accepted close
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn failed_publication_cleans_staging_and_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blocked.wav");
        let mut s = segmenter(0, 1);
        s.open().unwrap();
        let mut w = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        w.append(&[0.5]).unwrap();
        s.push_frames(&[0.5]);
        std::fs::create_dir(&path).unwrap(); // deterministic rename failure, even as root
        let failure = w.finalize(&s.close().unwrap()).unwrap_err();
        assert!(hound::WavReader::open(&path).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        drop(failure); // cleanup already happened, even while the error was held
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, b"existing").unwrap();
        let mut w = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        w.append(&[0.5]).unwrap();
        s.open().unwrap();
        s.push_frames(&[0.5]);
        assert!(w.finalize(&s.close().unwrap()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"existing");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_format_frames_or_boundary_cannot_publish() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invalid.wav");
        assert!(ClipWriter::start(&path, 48_000, 1).is_err());
        assert!(ClipWriter::start(&path, SAMPLE_RATE, 2).is_err());
        let mut s = segmenter(0, 1);
        s.open().unwrap();
        s.push_frames(&[0.5]);
        let boundary = s.close().unwrap();
        let mut w = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        w.append(&[0.5, 0.5]).unwrap();
        assert!(w.finalize(&boundary).is_err());
        let mut w = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        w.append(&[0.5]).unwrap();
        let wrong_rate = ClipBoundary {
            duration: Duration::from_micros(125),
            ..boundary
        };
        assert!(w.finalize(&wrong_rate).is_err());
        let mut w = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        w.append(&[0.5]).unwrap();
        assert!(w.append(&[f32::NAN]).is_err());
        assert!(w.finalize(&boundary).is_err());
        let mut w = ClipWriter::start(&path, SAMPLE_RATE, 1).unwrap();
        w.frames = MAX_FRAMES; // exercise RIFF overflow without a 4 GiB fixture
        assert!(w.append(&[0.5]).is_err());
        drop(w);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
