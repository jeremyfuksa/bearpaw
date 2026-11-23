//! Live monitoring of the captured scanner audio: Bearpaw plays the same frames
//! it records through an output device, with its own on/off and volume.
//!
//! The cable that feeds recording also mutes the scanner's speaker (#383,
//! 2026-10-17), so without monitor playback, turning recording on makes the
//! radio go silent. Monitoring is not a second capture: it consumes the frames
//! `audio::capture` already delivers, beside the recorder.
//!
//! Nothing here opens a device, builds a stream or stores a preference. The
//! output stream, its lifetime and its routes belong to a later slice; these
//! are the two pieces whose behaviour is easiest to get wrong, kept pure so
//! they can be tested without an output device.
//!
//! # Gain is software, and monitor-only
//!
//! [`MonitorGain`] scales a copy on the way to the output. It never writes to
//! the captured frames, never sends a command to the scanner and never touches
//! `VOL`: the headphone jack follows `VOL`, so `VOL` is the recording level, and
//! lowering computer playback must not lower what is recorded. The same rule
//! separates the two switches: `on` is the user's choice, `muted` is the hold
//! while a recorded clip plays (#927). A clip mutes the live monitor only;
//! recording continues, and live audio resumes when the clip ends.
//!
//! # The buffer is a bounded live window
//!
//! [`MonitorBuffer`] holds at most its capacity of mono frames at
//! [`super::wav::SAMPLE_RATE`]. Three behaviours are deliberate:
//!
//! - **Full: the oldest frames go.** Monitoring must stay close to live, so a
//!   slow consumer loses the oldest audio instead of accumulating delay.
//! - **Empty: silence.** A dropout is written as zeros and counted. Repeating
//!   the last frame would read as a stutter and hide the gap.
//! - **Discontinuous input: [`MonitorBuffer::clear`].** A new capture
//!   connection, or a `start_frame` that does not continue the previous one,
//!   means audio was missed. Clearing first makes silence bridge the gap rather
//!   than audio spliced across it.
//!
//! A capture session hands its frames to exactly one receiver, so the recorder
//! and the monitor cannot both own it. A fanout has to split that stream into a
//! bounded queue per consumer: the monitor must never take the recorder's
//! receiver, and a stalled monitor must not starve the recorder. That fanout,
//! and the engine that owns an output stream and drains this buffer, are
//! follow-up work.

use std::collections::VecDeque;

/// A bounded FIFO of mono frames, written by the capture side and drained by the
/// output callback.
///
/// Construction allocates once. [`push`](Self::push) and
/// [`fill`](Self::fill) never grow the queue, so a callback can use it without
/// allocating. Counters are lifetime totals for the session; `clear` keeps them.
#[derive(Debug)]
pub struct MonitorBuffer {
    frames: VecDeque<f32>,
    capacity: usize,
    dropped: u64,
    underrun: u64,
}

impl MonitorBuffer {
    /// `capacity` is in mono frames at [`super::wav::SAMPLE_RATE`]: 4 800 frames
    /// is 300 ms. Zero is allowed and always produces silence, which makes
    /// "monitor off" expressible without a second flag.
    pub fn new(capacity: usize) -> Self {
        Self {
            frames: VecDeque::with_capacity(capacity),
            capacity,
            dropped: 0,
            underrun: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn buffered_frames(&self) -> usize {
        self.frames.len()
    }

    /// Queue frames for playback. When the queue is full the oldest frames are
    /// discarded to make room, so the audio stays current and latency stays
    /// bounded by the capacity. Returns the frames dropped by this call.
    pub fn push(&mut self, samples: &[f32]) -> u64 {
        let mut dropped = 0;
        for &sample in samples {
            if self.frames.len() == self.capacity {
                if self.frames.pop_front().is_none() {
                    // A zero-capacity window holds nothing, so every frame is
                    // dropped and the queue is never entered.
                    dropped += 1;
                    continue;
                }
                dropped += 1;
            }
            self.frames.push_back(sample);
        }
        self.dropped += dropped;
        dropped
    }

    /// Fill `out` from the queue, then with silence. Returns the underrun frames
    /// written by this call, including all of `out` after a `clear`. Silence is
    /// always written, so the caller can hand `out` straight to the device.
    pub fn fill(&mut self, out: &mut [f32]) -> usize {
        let mut underrun = 0;
        for slot in out.iter_mut() {
            match self.frames.pop_front() {
                Some(sample) => *slot = sample,
                None => {
                    *slot = 0.0;
                    underrun += 1;
                }
            }
        }
        self.underrun += underrun as u64;
        underrun
    }

    /// Discard queued audio after a discontinuity, before feeding frames from a
    /// new capture connection or an index that skips frames.
    pub fn clear(&mut self) {
        self.frames.clear();
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped
    }

    pub fn underrun_frames(&self) -> u64 {
        self.underrun
    }
}

/// Monitor gain: an on/off switch, a volume, and the temporary mute that clip
/// playback holds.
///
/// `on` and `muted` are separate so resuming live audio restores the user's own
/// choice, and so a mute never reads back as "monitoring was turned off".
/// Neither affects capture: the recorder keeps receiving the unscaled frames.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorGain {
    on: bool,
    muted: bool,
    volume: f32,
}

impl Default for MonitorGain {
    /// On at unity, matching "monitor playback defaults to on once an input is
    /// selected" (#383). Nothing here starts a stream.
    fn default() -> Self {
        Self {
            on: true,
            muted: false,
            volume: 1.0,
        }
    }
}

impl MonitorGain {
    /// The user's on/off choice. Does not start or stop capture or monitoring;
    /// the engine owns the stream.
    pub fn set_on(&mut self, on: bool) {
        self.on = on;
    }

    /// Hold the monitor silent while a clip plays (#927). Recording is
    /// unaffected, and the same volume is restored when this is cleared.
    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }

    /// Linear 0.0..=1.0. Out-of-range values are clamped; a non-finite value is
    /// ignored, so a bad client cannot poison the output with NaN or move the
    /// level to something nobody asked for.
    pub fn set_volume(&mut self, volume: f32) {
        if volume.is_finite() {
            self.volume = volume.clamp(0.0, 1.0);
        }
    }

    pub fn on(&self) -> bool {
        self.on
    }

    pub fn muted(&self) -> bool {
        self.muted
    }

    pub fn volume(&self) -> f32 {
        self.volume
    }

    /// Whether the monitor is audible right now: on and not muted by a clip.
    pub fn audible(&self) -> bool {
        self.on && !self.muted
    }

    /// The multiplier applied to output samples: the volume while audible,
    /// otherwise zero.
    pub fn gain(&self) -> f32 {
        if self.audible() {
            self.volume
        } else {
            0.0
        }
    }

    /// One output sample: silent when off or muted, otherwise scaled and clipped
    /// to full scale. A non-finite sample becomes silence rather than being
    /// handed to a device.
    pub fn apply(&self, sample: f32) -> f32 {
        let gain = self.gain();
        if gain == 0.0 {
            return 0.0;
        }
        let sample = sample * gain;
        if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        }
    }

    /// Scale a block in place. The caller owns this buffer; the captured frames
    /// it copies from are untouched, which is what keeps the recording level
    /// independent of the monitor.
    pub fn apply_all(&self, samples: &mut [f32]) {
        for sample in samples.iter_mut() {
            *sample = self.apply(*sample);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(buffer: &mut MonitorBuffer, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0; frames];
        buffer.fill(&mut out);
        out
    }

    #[test]
    fn a_full_window_keeps_the_newest_frames_and_counts_the_oldest_as_dropped() {
        let mut buffer = MonitorBuffer::new(4);
        assert_eq!(buffer.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 2);
        assert_eq!(buffer.capacity(), 4);
        assert_eq!(buffer.buffered_frames(), 4);
        assert_eq!(buffer.dropped_frames(), 2);
        assert_eq!(drain(&mut buffer, 4), [3.0, 4.0, 5.0, 6.0]);
        assert_eq!(buffer.underrun_frames(), 0);
    }

    #[test]
    fn an_empty_window_writes_silence_and_never_repeats_the_last_frame() {
        let mut buffer = MonitorBuffer::new(8);
        buffer.push(&[0.5, -0.25]);
        assert_eq!(drain(&mut buffer, 4), [0.5, -0.25, 0.0, 0.0]);
        assert_eq!(buffer.underrun_frames(), 2);
        assert_eq!(drain(&mut buffer, 2), [0.0, 0.0]);
        assert_eq!(buffer.underrun_frames(), 4);
    }

    #[test]
    fn a_partial_block_leaves_the_rest_queued_for_the_next_callback() {
        let mut buffer = MonitorBuffer::new(8);
        buffer.push(&[0.1, 0.2, 0.3, 0.4, 0.5]);
        assert_eq!(drain(&mut buffer, 2), [0.1, 0.2]);
        assert_eq!(buffer.buffered_frames(), 3);
        assert_eq!(drain(&mut buffer, 4), [0.3, 0.4, 0.5, 0.0]);
        assert_eq!(buffer.underrun_frames(), 1);
    }

    #[test]
    fn clear_discards_queued_audio_and_keeps_session_counters() {
        let mut buffer = MonitorBuffer::new(4);
        buffer.push(&[1.0, 2.0, 3.0, 4.0]);
        buffer.clear();
        assert_eq!(buffer.buffered_frames(), 0);
        assert_eq!(drain(&mut buffer, 2), [0.0, 0.0]);
        assert_eq!(buffer.dropped_frames(), 0);
        assert_eq!(buffer.underrun_frames(), 2);
    }

    #[test]
    fn zero_capacity_is_always_silence() {
        let mut buffer = MonitorBuffer::new(0);
        assert_eq!(buffer.push(&[1.0, 2.0, 3.0]), 3);
        assert_eq!(buffer.buffered_frames(), 0);
        assert_eq!(buffer.dropped_frames(), 3);
        assert_eq!(drain(&mut buffer, 2), [0.0, 0.0]);
    }

    #[test]
    fn default_is_on_at_unity() {
        let gain = MonitorGain::default();
        assert!(gain.on());
        assert!(!gain.muted());
        assert_eq!(gain.volume(), 1.0);
        assert!(gain.audible());
        assert_eq!(gain.gain(), 1.0);
    }

    #[test]
    fn the_clip_mute_silences_only_the_monitor_and_restores_the_volume() {
        let mut gain = MonitorGain::default();
        gain.set_volume(0.4);
        gain.set_muted(true);
        assert!(!gain.audible());
        assert_eq!(gain.gain(), 0.0);
        assert_eq!(gain.apply(1.0), 0.0);
        gain.set_muted(false);
        assert!(gain.audible());
        assert_eq!(gain.apply(0.5), 0.2);
    }

    #[test]
    fn off_is_independent_of_the_clip_mute_and_restores_the_same_volume() {
        let mut gain = MonitorGain::default();
        gain.set_volume(0.75);
        gain.set_on(false);
        assert!(!gain.audible());
        assert_eq!(gain.apply(-0.5), 0.0);
        gain.set_on(true);
        assert!(gain.audible());
        assert_eq!(gain.gain(), 0.75);
        gain.set_on(false);
        gain.set_muted(true);
        gain.set_muted(false);
        assert!(
            !gain.audible(),
            "clearing a clip mute must not turn monitoring on"
        );
    }

    #[test]
    fn volume_is_clamped_and_a_non_finite_value_is_ignored() {
        let mut gain = MonitorGain::default();
        gain.set_volume(2.0);
        assert_eq!(gain.volume(), 1.0);
        gain.set_volume(-1.0);
        assert_eq!(gain.volume(), 0.0);
        gain.set_volume(0.6);
        gain.set_volume(f32::NAN);
        assert_eq!(gain.volume(), 0.6);
    }

    #[test]
    fn output_is_clipped_to_full_scale_and_non_finite_input_is_silence() {
        let gain = MonitorGain::default();
        assert_eq!(gain.apply(2.0), 1.0);
        assert_eq!(gain.apply(-2.0), -1.0);
        assert_eq!(gain.apply(f32::NAN), 0.0);
        assert_eq!(gain.apply(f32::INFINITY), 0.0);
    }

    #[test]
    fn a_muted_monitor_keeps_draining_so_resuming_is_not_stale() {
        let mut buffer = MonitorBuffer::new(4);
        buffer.push(&[0.5, 0.5]);
        let mut gain = MonitorGain::default();
        gain.set_muted(true);
        let mut out = drain(&mut buffer, 2);
        gain.apply_all(&mut out);
        assert_eq!(out, [0.0, 0.0]);
        assert_eq!(buffer.buffered_frames(), 0);
        assert_eq!(buffer.underrun_frames(), 0);
        gain.set_muted(false);
        assert_eq!(drain(&mut buffer, 1), [0.0]);
    }
}
