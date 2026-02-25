//! Priority command queue: control > telemetry > background.
//! Phase 1: single-threaded; one command in flight.

pub const PRIORITY_CONTROL: u8 = 0;
pub const PRIORITY_TELEMETRY: u8 = 1;
pub const PRIORITY_BACKGROUND: u8 = 2;

// Stub: full scheduler will be async queue driving transport.
// For Phase 1 we can drive from the poll loop with a simple mutex or channel.
#[derive(Clone, Copy, Debug)]
pub struct Scheduler;
