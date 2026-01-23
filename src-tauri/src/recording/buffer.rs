use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const DEFAULT_PREROLL_SECONDS: usize = 10;

pub struct AudioBuffer {
    buffer: VecDeque<f32>,
    capacity: usize,
    sample_rate: u32,
}

impl AudioBuffer {
    pub fn new(sample_rate: u32, preroll_seconds: Option<usize>) -> Self {
        let preroll = preroll_seconds.unwrap_or(DEFAULT_PREROLL_SECONDS);
        let capacity = sample_rate as usize * preroll;

        Self {
            buffer: VecDeque::with_capacity(capacity),
            capacity,
            sample_rate,
        }
    }

    pub fn push(&mut self, sample: f32) {
        self.buffer.push_back(sample);
        if self.buffer.len() > self.capacity {
            self.buffer.pop_front();
        }
    }

    pub fn extend(&mut self, samples: &[f32]) {
        for &sample in samples {
            self.push(sample);
        }
    }

    pub fn drain_all(&mut self) -> Vec<f32> {
        self.buffer.drain(..).collect()
    }

    pub fn peek_all(&self) -> Vec<f32> {
        self.buffer.iter().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    pub fn duration_seconds(&self) -> f64 {
        self.len() as f64 / self.sample_rate as f64
    }
}

pub type SharedBuffer = Arc<Mutex<AudioBuffer>>;
