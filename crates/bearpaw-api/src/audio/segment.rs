//! Hardware-free, squelch-delimited boundaries for a future recording worker.
//!
//! Feed ordered mono `f32` frames at one fixed sample rate, interleaving squelch
//! events at the current frame cursor. One frame is one sample, not a callback
//! block. Pre-roll recovers audio preceding a polled open; it does not count
//! toward the minimum transmission length. No clock, device, or file is used.
//!
//! A future writer should stage the pre-roll returned by `open` followed by the
//! frames it feeds while open, retaining them only when `close` accepts the
//! boundary. This module buffers only pre-roll, not whole transmissions. Order
//! events before any blocking writes; dropped frames must not be silently fed
//! as a continuous stream. Post-roll, interrupted clips and hit association are
//! deliberately left to later slices. Dropping the segmenter abandons an open.

use std::collections::VecDeque;
use std::num::NonZeroU32;
use std::time::Duration;

/// An accepted clip's half-open offsets in the input stream, starting at zero.
#[derive(Debug, PartialEq, Eq)]
pub struct ClipBoundary {
    /// First retained frame, including available pre-roll.
    pub start_frame: u64,
    /// Cursor when squelch opened; the minimum-duration gate starts here.
    pub open_frame: u64,
    /// Cursor when squelch closed (exclusive).
    pub end_frame: u64,
    /// Length including pre-roll, derived solely from frames and sample rate.
    pub duration: Duration,
}

/// A bounded pre-roll ring and at most one squelch-open interval.
pub struct Segmenter {
    sample_rate: NonZeroU32,
    pre_roll_frames: usize,
    min_frames: u64,
    ring: VecDeque<f32>,
    cursor: u64,
    active: Option<(u64, u64)>,
}

impl Segmenter {
    /// Timing limits are frame counts at `sample_rate`; rate and limits remain
    /// fixed for this stream. A zero pre-roll is valid. Even with a zero minimum,
    /// an open/close with no intervening frames never produces an empty clip.
    pub fn new(sample_rate: NonZeroU32, pre_roll_frames: usize, min_frames: u64) -> Self {
        Self {
            sample_rate,
            pre_roll_frames,
            min_frames,
            ring: VecDeque::new(),
            cursor: 0,
            active: None,
        }
    }

    /// Advance the sample clock and retain only the newest pre-roll frames.
    /// Call for every block, including while squelch is closed. Empty blocks
    /// have no effect; callback block size does not affect boundaries.
    pub fn push_frames(&mut self, frames: &[f32]) {
        self.cursor += frames.len() as u64;
        if self.pre_roll_frames == 0 {
            return;
        }
        for &frame in frames {
            if self.ring.len() == self.pre_roll_frames {
                self.ring.pop_front();
            }
            self.ring.push_back(frame);
        }
    }

    /// Open at the current cursor and return available pre-roll, oldest first.
    /// Repeated opens are ignored (`None`) until a close: callers may forward
    /// repeated polled squelch states without restarting the minimum gate.
    pub fn open(&mut self) -> Option<Vec<f32>> {
        if self.active.is_some() {
            return None;
        }
        self.active = Some((self.cursor - self.ring.len() as u64, self.cursor));
        Some(self.ring.iter().copied().collect())
    }

    /// Close at the current cursor. Return no clip for an unmatched close or
    /// a transmission below the minimum. Padding cannot rescue a key-up.
    /// The ring survives closes, so adjacent clips may share pre-roll frames.
    pub fn close(&mut self) -> Option<ClipBoundary> {
        let (start_frame, open_frame) = self.active.take()?;
        let live_frames = self.cursor - open_frame;
        if live_frames == 0 || live_frames < self.min_frames {
            return None;
        }
        let frames = self.cursor - start_frame;
        let rate = u64::from(self.sample_rate.get());
        Some(ClipBoundary {
            start_frame,
            open_frame,
            end_frame: self.cursor,
            duration: Duration::new(
                frames / rate,
                ((frames % rate) * 1_000_000_000 / rate) as u32,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segmenter(pre_roll: usize, minimum: u64) -> Segmenter {
        Segmenter::new(NonZeroU32::new(1_000).unwrap(), pre_roll, minimum)
    }

    #[test]
    fn pre_roll_recovers_audio_before_a_polled_open_and_is_bounded() {
        let mut s = segmenter(200, 100);
        s.push_frames(&[0.0; 500]);
        s.push_frames(&[0.25; 100]); // audio before the next squelch poll
        let pre_roll = s.open().unwrap();
        assert_eq!(pre_roll, [&[0.0; 100][..], &[0.25; 100][..]].concat());
        s.push_frames(&[0.5; 100]);
        assert_eq!(
            s.close(),
            Some(ClipBoundary {
                start_frame: 400,
                open_frame: 600,
                end_frame: 700,
                duration: Duration::from_millis(300),
            })
        );
    }

    #[test]
    fn minimum_excludes_pre_roll_and_accepts_the_exact_threshold() {
        let mut s = segmenter(200, 100);
        s.push_frames(&[0.25; 200]);
        s.open().unwrap();
        s.push_frames(&[0.5; 99]);
        assert_eq!(s.close(), None);
        assert_eq!(s.open().unwrap().len(), 200); // discard preserves ring
        s.push_frames(&[0.5; 100]);
        assert_eq!(s.close().unwrap().duration, Duration::from_millis(300));
    }

    #[test]
    fn back_to_back_hits_keep_separate_boundaries_and_fresh_pre_roll() {
        let mut s = segmenter(2, 2);
        assert_eq!(s.open(), Some(vec![])); // startup has no pre-roll
        s.push_frames(&[0.1, 0.2, 0.3]);
        let first = s.close().unwrap();
        assert_eq!(s.open(), Some(vec![0.2, 0.3]));
        s.push_frames(&[0.4, 0.5]);
        let second = s.close().unwrap();
        assert_eq!((first.start_frame, first.end_frame), (0, 3));
        assert_eq!(
            (second.start_frame, second.open_frame, second.end_frame),
            (1, 3, 5)
        );
    }

    #[test]
    fn unmatched_and_repeated_events_do_not_create_or_restart_clips() {
        let mut s = segmenter(0, 3);
        assert_eq!(s.close(), None);
        s.push_frames(&[0.0]);
        assert_eq!(s.open(), Some(vec![]));
        s.push_frames(&[0.5; 2]);
        assert_eq!(s.open(), None);
        s.push_frames(&[0.5]);
        let clip = s.close().unwrap();
        assert_eq!(
            (clip.start_frame, clip.open_frame, clip.end_frame),
            (1, 1, 4)
        );
        assert_eq!(s.close(), None);
    }

    #[test]
    fn empty_frames_and_zero_minimum_do_not_create_empty_clips() {
        let mut s = segmenter(10, 0);
        s.push_frames(&[0.1, 0.2]);
        assert_eq!(s.open(), Some(vec![0.1, 0.2])); // partial startup ring
        s.push_frames(&[]);
        assert_eq!(s.close(), None);
        s.open().unwrap();
        s.push_frames(&[0.3]);
        assert_eq!(s.close().unwrap().duration, Duration::from_millis(3));
    }

    #[test]
    fn timing_depends_on_frames_not_callback_sizes_or_processing_delays() {
        fn run(blocks: &[usize]) -> ClipBoundary {
            let mut s = Segmenter::new(NonZeroU32::new(44_100).unwrap(), 0, 1);
            s.open().unwrap();
            for &size in blocks {
                s.push_frames(&vec![0.5; size]);
            }
            s.close().unwrap()
        }
        let clip = run(&[44_101]);
        assert_eq!(clip, run(&[1, 10_000, 0, 34_100]));
        assert_eq!(clip.duration, Duration::new(1, 22_675));
    }
}
