//! Continuity of the captured frame stream: what may be joined to what.
//!
//! `capture::Frames` is ordered but not gapless. A full outbound queue drops
//! whole chunks, and a reconnect delivers a new `connection` whose cursor
//! begins again at zero. Neither is visible in `samples`, so nothing that only
//! reads them can tell: the merged `Segmenter` would accept pre-break audio as
//! contiguous pre-roll, and `ClipWriter::finalize` validates a boundary only
//! against the frames it was given, so a clip spliced across a break would
//! publish as one transmission. The promise `Frames` makes is from one arrival
//! to the next, so only a consumer that remembers the previous arrival can
//! check it.
//!
//! Pure and single-consumer: no device, clock, queue or file. One `Continuity`
//! per consumer. `Segmenter` cannot be reset mid-stream, so a consumer must
//! build a new one after every `Break`: the old ring still holds audio from
//! before the break, and `open` would return it as if it belonged to the next
//! clip. A break is also where a staged, unfinished clip stops being one clip.

use super::capture::Frames;

/// Where the consumer is in the stream: the connection being read, and the
/// next frame it expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub connection: u64,
    pub next_frame: u64,
}

/// Why two arrivals cannot be joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Break {
    /// Chunks were dropped between arrivals; `frames` of audio never arrived.
    Dropped { frames: u64 },
    /// Capture reconnected, so this is unrelated audio. The cursor restarted,
    /// and `skipped` frames at the head of the new connection are missing.
    Reconnected {
        previous: u64,
        current: u64,
        skipped: u64,
    },
    /// The cursor moved backwards inside one connection, so these frames begin
    /// before audio already delivered and must not be appended again. Only a
    /// tail past the cursor would be new, and it is discarded with the rest.
    Rewound { frames: u64 },
}

/// What one arrival continues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arrival {
    /// The first arrival this consumer has seen; the stream was already
    /// running, so nothing precedes it.
    Start,
    /// Contiguous with the previous arrival: safe to append and to keep
    /// pre-roll across.
    Continuous,
    /// Not contiguous. Abandon anything staged across the break.
    Break(Break),
}

/// Classifies arrivals against the one before them. Cheap enough for the
/// capture consumer's hot path: no allocation, no locking, no clock.
#[derive(Debug, Default)]
pub struct Continuity {
    /// Connection and next expected frame, once one arrival has been seen.
    last: Option<(u64, u64)>,
}

impl Continuity {
    pub fn new() -> Self {
        Self::default()
    }

    /// Classify `frames` and move the cursor past what it delivered. A rewound
    /// chunk is rejected whole and never moves the cursor backwards, so a
    /// replay is discarded until the producer's own cursor catches up.
    pub fn observe(&mut self, frames: &Frames) -> Arrival {
        let end = frames.start_frame + frames.samples.len() as u64;
        let Some((connection, next_frame)) = self.last else {
            self.last = Some((frames.connection, end));
            return Arrival::Start;
        };
        if frames.connection != connection {
            self.last = Some((frames.connection, end));
            return Arrival::Break(Break::Reconnected {
                previous: connection,
                current: frames.connection,
                skipped: frames.start_frame,
            });
        }
        if frames.start_frame > next_frame {
            self.last = Some((connection, end));
            return Arrival::Break(Break::Dropped {
                frames: frames.start_frame - next_frame,
            });
        }
        if frames.start_frame < next_frame {
            // A chunk that overlaps delivered audio is unusable as a whole, but
            // any part of it past the cursor is audio the producer considers
            // sent, so skip it rather than report a gap that never existed.
            self.last = Some((connection, next_frame.max(end)));
            return Arrival::Break(Break::Rewound {
                frames: next_frame - frames.start_frame,
            });
        }
        self.last = Some((connection, end));
        Arrival::Continuous
    }

    /// The stream position of an event applied now: the connection and the
    /// next frame this consumer expects. `None` until the first arrival.
    pub fn cursor(&self) -> Option<Cursor> {
        self.last.map(|(connection, next_frame)| Cursor {
            connection,
            next_frame,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(connection: u64, start_frame: u64, len: usize) -> Frames {
        Frames {
            connection,
            start_frame,
            samples: vec![0.0; len],
        }
    }

    #[test]
    fn contiguous_arrivals_advance_the_cursor_by_what_arrived() {
        let mut continuity = Continuity::new();
        assert_eq!(continuity.cursor(), None);
        assert_eq!(continuity.observe(&frames(1, 0, 1024)), Arrival::Start);
        assert_eq!(
            continuity.cursor(),
            Some(Cursor {
                connection: 1,
                next_frame: 1024
            })
        );
        assert_eq!(continuity.observe(&frames(1, 1024, 1)), Arrival::Continuous);
        assert_eq!(
            continuity.observe(&frames(1, 1025, 1024)),
            Arrival::Continuous
        );
        assert_eq!(
            continuity.cursor(),
            Some(Cursor {
                connection: 1,
                next_frame: 2049
            })
        );
    }

    #[test]
    fn the_first_arrival_is_start_wherever_the_stream_already_is() {
        let mut early = Continuity::new();
        assert_eq!(early.observe(&frames(1, 0, 8)), Arrival::Start);
        // Joining a stream that has been capturing for 0.6 s is not a jump.
        let mut joined = Continuity::new();
        assert_eq!(joined.observe(&frames(3, 9_600, 8)), Arrival::Start);
        assert_eq!(
            joined.cursor(),
            Some(Cursor {
                connection: 3,
                next_frame: 9_608
            })
        );
    }

    #[test]
    fn dropped_chunks_report_the_exact_missing_count() {
        let mut continuity = Continuity::new();
        continuity.observe(&frames(4, 0, 1024));
        assert_eq!(
            continuity.observe(&frames(4, 2048, 1024)),
            Arrival::Break(Break::Dropped { frames: 1024 })
        );
        assert_eq!(
            continuity.cursor(),
            Some(Cursor {
                connection: 4,
                next_frame: 3072
            })
        );
        // Consecutive drops each report their own span, and the next contiguous
        // arrival is joined again.
        assert_eq!(
            continuity.observe(&frames(4, 5000, 7)),
            Arrival::Break(Break::Dropped { frames: 1928 })
        );
        assert_eq!(continuity.observe(&frames(4, 5007, 7)), Arrival::Continuous);
    }

    #[test]
    fn a_reconnect_is_one_break_naming_its_skipped_head() {
        let mut continuity = Continuity::new();
        continuity.observe(&frames(7, 0, 1024));
        assert_eq!(
            continuity.observe(&frames(8, 0, 1024)),
            Arrival::Break(Break::Reconnected {
                previous: 7,
                current: 8,
                skipped: 0,
            })
        );
        assert_eq!(
            continuity.observe(&frames(8, 1024, 10)),
            Arrival::Continuous
        );
        // A new connection wins over the cursor comparison: 512 is behind the
        // old cursor, and it is a skipped head, not a rewind.
        assert_eq!(
            continuity.observe(&frames(9, 512, 10)),
            Arrival::Break(Break::Reconnected {
                previous: 8,
                current: 9,
                skipped: 512,
            })
        );
    }

    #[test]
    fn a_rewind_is_discarded_until_the_cursor_catches_up() {
        let mut continuity = Continuity::new();
        continuity.observe(&frames(1, 0, 1024));
        assert_eq!(
            continuity.observe(&frames(1, 0, 1024)),
            Arrival::Break(Break::Rewound { frames: 1024 })
        );
        assert_eq!(
            continuity.cursor(),
            Some(Cursor {
                connection: 1,
                next_frame: 1024
            })
        );
        // An overlapping replay starts inside delivered audio, so it is still
        // not joined, and its new tail is skipped rather than invented as a gap.
        assert_eq!(
            continuity.observe(&frames(1, 512, 1024)),
            Arrival::Break(Break::Rewound { frames: 512 })
        );
        assert_eq!(
            continuity.cursor(),
            Some(Cursor {
                connection: 1,
                next_frame: 1536
            })
        );
        assert_eq!(continuity.observe(&frames(1, 1536, 8)), Arrival::Continuous);
    }

    #[test]
    fn an_empty_block_never_invents_a_jump() {
        let mut continuity = Continuity::new();
        assert_eq!(continuity.observe(&frames(2, 0, 0)), Arrival::Start);
        assert_eq!(
            continuity.cursor(),
            Some(Cursor {
                connection: 2,
                next_frame: 0
            })
        );
        assert_eq!(continuity.observe(&frames(2, 0, 4)), Arrival::Continuous);
    }
}
