//! Internal capture foundation; nothing starts it in the app yet.
//!
//! The owner thread alone creates, plays and drops the source. Callbacks never
//! wait for consumers or take the status lock. Drop requests shutdown without
//! joining (device opening/closing may block); no scanner/async task waits on it.
//! Conversion retains `convert`'s linear interpolation, NOT anti-alias filtering.

use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

use super::convert::FrameConverter;

const CHUNK_FRAMES: usize = 1024;
const QUEUE_CHUNKS: usize = 32;
const RETRY: Duration = Duration::from_secs(2);

/// Always mono f32 at `wav::SAMPLE_RATE` (16 kHz), at most 1024 frames.
/// A new connection or a non-contiguous `start_frame` means a discontinuity:
/// downstream must not interpolate or segment across it. Queued old-connection
/// audio may still precede new-connection audio after a reconnect.
#[derive(Debug)]
pub struct Frames {
    pub connection: u64,
    pub start_frame: u64,
    pub samples: Vec<f32>,
}

#[derive(Clone, Debug, Default)]
pub struct CaptureStatus {
    /// Worker is alive/requested, including delayed retries; NOT proof of audio.
    pub running: bool,
    /// Source successfully opened and played; false after a reported failure.
    pub connected: bool,
    pub device_name: Option<String>,
    /// Most recent failure, retained after recovery for diagnostics.
    pub last_error: Option<String>,
    /// Mono 16 kHz frames discarded because the outbound queue was full.
    pub dropped_frames: u64,
}

#[derive(Default)]
struct Shared {
    status: Mutex<CaptureStatus>,
    stopped: AtomicBool,
    dropped: AtomicU64,
}

struct WorkerStatus(Arc<Shared>);

impl Drop for WorkerStatus {
    fn drop(&mut self) {
        let mut status = self.0.status.lock().unwrap();
        status.running = false;
        status.connected = false;
        if std::thread::panicking() {
            status.last_error = Some("audio capture worker panicked".into());
        }
    }
}

enum Event {
    Wake,
    Failed(String),
}

/// Sendable handle; the non-Send CPAL stream never leaves its owner thread.
/// Dropping this handle requests shutdown. The receiver can be moved separately.
pub struct Capture {
    shared: Arc<Shared>,
    events: mpsc::SyncSender<Event>,
}

impl Capture {
    /// Accept a discovery id verbatim; no default fallback, selection or storage.
    /// Enumeration/topology changes invalidate ids, so retries may keep failing
    /// until the caller supplies a fresh id in a new capture session.
    pub fn spawn(device_id: String) -> std::io::Result<(Self, mpsc::Receiver<Frames>)> {
        Self::spawn_source(device_id, RETRY, open)
    }

    pub fn status(&self) -> CaptureStatus {
        let mut status = self.shared.status.lock().unwrap().clone();
        status.running &= !self.shared.stopped.load(Ordering::Acquire);
        status.connected &= status.running;
        status.dropped_frames = self.shared.dropped.load(Ordering::Relaxed);
        status
    }

    fn spawn_source<S: 'static>(
        id: String,
        retry: Duration,
        mut source: impl FnMut(&str, Output) -> Result<(String, S), String> + Send + 'static,
    ) -> std::io::Result<(Self, mpsc::Receiver<Frames>)> {
        let shared = Arc::new(Shared::default());
        shared.status.lock().unwrap().running = true;
        let (tx, frames) = mpsc::sync_channel(QUEUE_CHUNKS);
        let (events, rx) = mpsc::sync_channel(1);
        let handle = Self {
            shared: shared.clone(),
            events: events.clone(),
        };
        std::thread::Builder::new()
            .name("audio-capture".into())
            .spawn(move || {
                let _status = WorkerStatus(shared.clone());
                let mut connection = 0;
                while !shared.stopped.load(Ordering::Acquire) {
                    // Discard errors belonging to the previous source only after it
                    // has been dropped. Each new source gets fresh converter state.
                    while rx.try_recv().is_ok() {}
                    connection += 1;
                    let output = Output {
                        tx: tx.clone(),
                        events: events.clone(),
                        shared: shared.clone(),
                        connection,
                    };
                    let (stream, error) = match source(&id, output) {
                        Ok((name, stream)) => {
                            {
                                let mut status = shared.status.lock().unwrap();
                                status.device_name = Some(name);
                                status.connected = true;
                            }
                            let error = loop {
                                if shared.stopped.load(Ordering::Acquire) {
                                    break None;
                                }
                                match rx.recv_timeout(Duration::from_millis(100)) {
                                    Ok(Event::Failed(error)) => break Some(error),
                                    Ok(Event::Wake) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                                    Err(mpsc::RecvTimeoutError::Disconnected) => break None,
                                }
                            };
                            (Some(stream), error)
                        }
                        Err(error) => (None, Some(error)),
                    };
                    {
                        let mut status = shared.status.lock().unwrap();
                        status.connected = false;
                        if let Some(error) = error {
                            status.last_error = Some(error);
                        }
                    }
                    // Report loss before a potentially slow device teardown.
                    drop(stream); // always on this thread, including reconnects
                    if shared.stopped.load(Ordering::Acquire) {
                        break;
                    }
                    // Even an immediately failing source must wait before reopening.
                    let deadline = std::time::Instant::now() + retry;
                    while !shared.stopped.load(Ordering::Acquire) {
                        let Some(left) = deadline.checked_duration_since(std::time::Instant::now())
                        else {
                            break;
                        };
                        let _ = rx.recv_timeout(left);
                    }
                }
            })?;
        Ok((handle, frames))
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::Release);
        let _ = self.events.try_send(Event::Wake);
    }
}

struct Output {
    tx: mpsc::SyncSender<Frames>,
    events: mpsc::SyncSender<Event>,
    shared: Arc<Shared>,
    connection: u64,
}

impl Output {
    fn fail(&self, error: String) {
        // Only the first pending error matters; bounded even if a driver floods.
        let _ = self.events.try_send(Event::Failed(error));
    }

    fn converter(self, rate: u32, channels: u16) -> Result<Sink, String> {
        let rate = NonZeroU32::new(rate).ok_or("zero input sample rate")?;
        let channels = NonZeroU16::new(channels).ok_or("zero input channels")?;
        Ok(Sink {
            converter: FrameConverter::new(rate, channels),
            rate,
            channels,
            output: self,
            cursor: 0,
            failed: false,
        })
    }
}

struct Sink {
    converter: FrameConverter,
    rate: NonZeroU32,
    channels: NonZeroU16,
    output: Output,
    cursor: u64,
    failed: bool,
}

impl Sink {
    fn push<T>(&mut self, data: &[T])
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        if self.failed {
            return;
        }
        // Bound temporary output too, even for huge host callbacks/upsampling.
        // One input frame can produce at most 16k outputs at a 1 Hz input rate.
        let input_frames = ((u64::from(self.rate.get()) * CHUNK_FRAMES as u64)
            / u64::from(super::wav::SAMPLE_RATE))
        .max(1) as usize;
        for block in data.chunks(input_frames * usize::from(self.channels.get())) {
            let mut samples = Vec::new();
            if let Err(error) = self.converter.push(block, &mut samples) {
                self.failed = true; // never continue interpolation after a gap
                self.output
                    .fail(format!("audio_conversion_failed: {error}"));
                return;
            }
            for chunk in samples.chunks(CHUNK_FRAMES) {
                let frames = Frames {
                    connection: self.output.connection,
                    start_frame: self.cursor,
                    samples: chunk.to_vec(),
                };
                self.cursor += chunk.len() as u64;
                match self.output.tx.try_send(frames) {
                    Ok(()) => {}
                    Err(mpsc::TrySendError::Full(_)) => {
                        self.output
                            .shared
                            .dropped
                            .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        self.output.shared.stopped.store(true, Ordering::Release);
                        let _ = self.output.events.try_send(Event::Wake);
                        return;
                    }
                }
            }
        }
    }
}

// Thin hardware boundary: enumerate using discovery's exact id, query the same
// default config as the meter, dispatch supported types, build and play. CPAL
// owns callback scheduling and reports device loss through its error callback.
fn open(id: &str, output: Output) -> Result<(String, cpal::Stream), String> {
    let host = cpal::default_host();
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    let device = devices
        .enumerate()
        .find_map(|(index, device)| {
            let name = device.name().ok()?;
            (super::device_id(index, &name) == id).then_some(device)
        })
        .ok_or_else(|| format!("audio_input_not_found: {id}"))?;
    let (name, config) = super::input_config(&device)?;
    let format = config.sample_format();
    let sink = output.converter(config.sample_rate().0, config.channels())?;
    let config = config.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, sink),
        SampleFormat::I16 => build::<i16>(&device, &config, sink),
        SampleFormat::U16 => build::<u16>(&device, &config, sink),
        SampleFormat::I32 => build::<i32>(&device, &config, sink),
        other => Err(format!("unsupported sample format {other}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((name, stream))
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut sink: Sink,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let errors = sink.output.events.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| sink.push(data),
            move |error| {
                let _ = errors.try_send(Event::Failed(error.to_string()));
            },
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(capacity: usize) -> (Output, mpsc::Receiver<Frames>, mpsc::Receiver<Event>) {
        let (tx, frames) = mpsc::sync_channel(capacity);
        let (events, rx) = mpsc::sync_channel(1);
        (
            Output {
                tx,
                events,
                shared: Arc::default(),
                connection: 7,
            },
            frames,
            rx,
        )
    }

    fn wait_until(mut predicate: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !predicate() {
            assert!(std::time::Instant::now() < deadline, "worker timed out");
            std::thread::yield_now();
        }
    }

    #[test]
    fn bounded_queue_counts_frames_and_exposes_gaps() {
        let (out, frames, _) = output(1);
        let shared = out.shared.clone();
        let mut sink = out.converter(16_000, 1).unwrap();
        sink.push(&vec![0.5_f32; CHUNK_FRAMES * 3]);
        assert_eq!(
            shared.dropped.load(Ordering::Relaxed),
            (CHUNK_FRAMES * 2) as u64
        );
        let first = frames.try_recv().unwrap();
        assert_eq!(first.samples, vec![0.5; CHUNK_FRAMES]);
        assert_eq!((first.connection, first.start_frame), (7, 0));
        assert!(frames.try_recv().is_err());
        sink.push(&[0.25_f32]);
        assert_eq!(
            frames.try_recv().unwrap().start_frame,
            (CHUNK_FRAMES * 3) as u64
        );
    }

    #[test]
    fn stalled_consumer_cannot_grow_worker_queue() {
        let (ready, rx) = mpsc::channel();
        let (capture, frames) = Capture::spawn_source("fake".into(), RETRY, move |_, out| {
            out.converter(16_000, 1)?
                .push(&vec![0.5_f32; CHUNK_FRAMES * (QUEUE_CHUNKS + 9)]);
            ready.send(()).unwrap();
            Ok(("fake".into(), ()))
        })
        .unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(frames.try_iter().count(), QUEUE_CHUNKS);
        assert_eq!(capture.status().dropped_frames, (CHUNK_FRAMES * 9) as u64);
    }

    #[test]
    fn upsampling_still_caps_each_outbound_chunk() {
        let (out, frames, _) = output(32);
        out.converter(1, 1).unwrap().push(&[0.0_f32, 1.0]);
        let chunks: Vec<_> = frames.try_iter().collect();
        assert!(chunks.iter().all(|f| f.samples.len() <= CHUNK_FRAMES));
        assert_eq!(
            chunks.iter().map(|f| f.samples.len()).sum::<usize>(),
            16_001
        );
    }

    #[test]
    fn fake_source_uses_converter_for_rates_channels_and_integer_formats() {
        let (out, frames, _) = output(32);
        let mut sink = out.converter(48_000, 2).unwrap();
        sink.push(&[0_i16, 0, 100, 100]);
        sink.push(&[200_i16, 200, 16384, 16384, 0, 0, 0, 0, -16384, -16384]);
        let samples: Vec<_> = frames.try_iter().flat_map(|f| f.samples).collect();
        assert_eq!(samples, [0.0, 0.5, -0.5]);
        let (out, frames, _) = output(32);
        out.converter(16_000, 1)
            .unwrap()
            .push(&[0_u16, 32768, 49152]);
        assert_eq!(frames.try_recv().unwrap().samples, [-1.0, 0.0, 0.5]);
        let (out, frames, _) = output(32);
        out.converter(16_000, 1)
            .unwrap()
            .push(&[i32::MIN, 0, 1073741824]);
        assert_eq!(frames.try_recv().unwrap().samples, [-1.0, 0.0, 0.5]);
    }

    #[test]
    fn invalid_input_fails_closed_and_error_queue_is_bounded() {
        let (out, frames, errors) = output(1);
        let mut sink = out.converter(16_000, 2).unwrap();
        sink.push(&[f32::NAN, 0.0]);
        sink.push(&[0.5_f32, 0.5]);
        for _ in 0..100 {
            sink.output.fail("another failure".into());
        }
        assert!(frames.try_recv().is_err());
        assert!(matches!(errors.try_recv(), Ok(Event::Failed(e)) if e.contains("non-finite")));
        assert!(errors.try_recv().is_err());
        let (out, _, _) = output(1);
        assert!(out.converter(0, 1).is_err());
        let (out, _, _) = output(1);
        assert!(out.converter(16_000, 0).is_err());
        let (out, _, errors) = output(1);
        out.converter(16_000, 2).unwrap().push(&[0.0_f32]);
        assert!(matches!(errors.try_recv(), Ok(Event::Failed(e)) if e.contains("interleaved")));
    }

    #[test]
    fn disconnecting_consumer_requests_shutdown_without_blocking_callback() {
        let (out, frames, _) = output(1);
        let shared = out.shared.clone();
        drop(frames);
        out.converter(16_000, 1).unwrap().push(&[0.0_f32]);
        assert!(shared.stopped.load(Ordering::Acquire));
    }

    #[test]
    fn worker_retries_failures_recovers_and_drops_non_send_source_on_owner() {
        // Rc pins the fake source to the owner thread, just like CPAL on hosts
        // where Stream is !Send. Drop also proves shutdown on that same thread.
        struct Source(std::rc::Rc<()>, std::thread::ThreadId, mpsc::Sender<()>);
        impl Drop for Source {
            fn drop(&mut self) {
                assert_eq!(self.1, std::thread::current().id());
                assert_eq!(std::rc::Rc::strong_count(&self.0), 1);
                self.2.send(()).unwrap();
            }
        }
        let (attempts, opened) = mpsc::channel();
        let (destroyed, drops) = mpsc::channel();
        let (callbacks, controls) = mpsc::channel();
        let retry = Duration::from_millis(150);
        let mut attempt = 0;
        let (capture, frames) = Capture::spawn_source("2:USB".into(), retry, move |id, out| {
            assert_eq!(id, "2:USB");
            attempt += 1;
            attempts.send(std::time::Instant::now()).unwrap();
            if attempt == 1 {
                return Err("open failed".into());
            }
            let errors = out.events.clone();
            let mut sink = out.converter(8_000, 1)?;
            sink.push(&[1.0_f32, 0.0]);
            callbacks.send(errors).unwrap();
            Ok((
                "USB".into(),
                Source(
                    std::rc::Rc::new(()),
                    std::thread::current().id(),
                    destroyed.clone(),
                ),
            ))
        })
        .unwrap();
        let first = opened.recv_timeout(Duration::from_secs(3)).unwrap();
        wait_until(|| capture.status().last_error.is_some());
        let status = capture.status();
        assert!(status.running);
        assert!(!status.connected);
        assert_eq!(status.last_error.as_deref(), Some("open failed"));
        let second = opened.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(second.duration_since(first) >= retry);
        let error = controls.recv_timeout(Duration::from_secs(3)).unwrap();
        wait_until(|| capture.status().connected);
        assert_eq!(capture.status().device_name.as_deref(), Some("USB"));
        let before = frames.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(before.samples, [1.0, 0.5, 0.0]);
        error.send(Event::Failed("device lost".into())).unwrap();
        drops.recv_timeout(Duration::from_secs(3)).unwrap();
        wait_until(|| !capture.status().connected);
        assert_eq!(capture.status().last_error.as_deref(), Some("device lost"));
        let third = opened.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(third.duration_since(second) >= retry);
        let after = frames.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(after.connection > before.connection);
        assert_eq!(after.start_frame, 0);
        assert_eq!(after.samples, before.samples); // fresh converter, no cross-gap interpolation
        wait_until(|| capture.status().connected);
        let shared = capture.shared.clone();
        drop(capture);
        drops.recv_timeout(Duration::from_secs(3)).unwrap();
        wait_until(|| !shared.status.lock().unwrap().running);
        assert!(!shared.status.lock().unwrap().connected);
    }

    #[test]
    fn shutdown_interrupts_retry_and_status_reports_drops() {
        let (attempts, rx) = mpsc::channel();
        let (capture, _frames) =
            Capture::spawn_source::<()>("missing".into(), Duration::from_secs(60), move |_, _| {
                attempts.send(()).unwrap();
                Err("missing input".into())
            })
            .unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let shared = capture.shared.clone();
        shared.dropped.store(42, Ordering::Relaxed);
        assert_eq!(capture.status().dropped_frames, 42);
        drop(capture);
        wait_until(|| !shared.status.lock().unwrap().running);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn worker_panic_does_not_leave_running_status_stuck() {
        let (capture, _frames) =
            Capture::spawn_source::<()>("fake".into(), RETRY, |_, _| panic!("fake source panic"))
                .unwrap();
        wait_until(|| !capture.status().running);
        assert!(!capture.status().connected);
        assert_eq!(
            capture.status().last_error.as_deref(),
            Some("audio capture worker panicked")
        );
    }

    /// Opt-in only: opens a real input and requires microphone permission.
    /// `cargo test -p bearpaw-api --lib captures_real_input -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn captures_real_input() {
        let id = super::super::list_input_devices().unwrap().remove(0).id;
        let (capture, frames) = Capture::spawn(id).unwrap();
        let chunk = frames
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| panic!("{error}: {:?}", capture.status()));
        assert!(!chunk.samples.is_empty());
        assert!(chunk.samples.len() <= CHUNK_FRAMES);
        assert!(chunk
            .samples
            .iter()
            .all(|s| s.is_finite() && s.abs() <= 1.0));
        println!("{:?}", capture.status());
    }
}
