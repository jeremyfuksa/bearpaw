use cpal::{traits::{DeviceTrait, HostTrait, StreamTrait}, Device, Host, SampleFormat};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use crate::recording::buffer::SharedBuffer;

pub fn list_audio_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let mut devices = Vec::new();

    if let Ok(input_devices) = host.input_devices() {
        for (index, device) in input_devices.enumerate() {
            let name = device.name().unwrap_or_else(|_| format!("Device {}", index));
            let default_config = device.default_input_config();

            let (channels, sample_rate) = if let Ok(config) = default_config {
                (config.channels(), config.sample_rate().0)
            } else {
                (1, 44100)
            };

            devices.push(AudioDevice {
                index,
                name,
                channels,
                sample_rate,
            });
        }
    }

    devices
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct AudioDevice {
    pub index: usize,
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
}

pub struct AudioCapture {
    _stream: Option<cpal::Stream>,
    buffer: SharedBuffer,
    sample_tx: Option<tokio::sync::mpsc::Sender<Vec<f32>>>,
}

impl AudioCapture {
    pub fn new(buffer: SharedBuffer) -> Self {
        Self {
            _stream: None,
            buffer,
            sample_tx: None,
        }
    }

    pub fn start(&mut self, device_index: Option<usize>) -> Result<(), Box<dyn std::error::Error>> {
        let host = cpal::default_host();
        let device = if let Some(idx) = device_index {
            host.input_devices()?
                .nth(idx)
                .ok_or("Device not found")?
        } else {
            host.default_input_device()
                .ok_or("No default input device")?
        };

        let config = device.default_input_config()?;
        let config_clone = config.clone();
        let sample_rate = config.sample_rate().0;

        let mut buffer_guard = self.buffer.lock().unwrap();
        *buffer_guard = crate::recording::buffer::AudioBuffer::new(sample_rate, Some(10));
        drop(buffer_guard);

        let buffer_clone = Arc::clone(&self.buffer);
        let (sample_tx, _sample_rx) = mpsc::channel::<Vec<f32>>(100);
        self.sample_tx = Some(sample_tx.clone());

        let stream_data_fn = move |data: &[u8], _: &cpal::InputCallbackInfo| {
            let samples: Vec<f32> = match config_clone.sample_format() {
                SampleFormat::F32 => {
                    let samples_f32 = unsafe {
                        std::slice::from_raw_parts(
                            data.as_ptr() as *const f32,
                            data.len() / 4,
                        )
                    };
                    samples_f32.to_vec()
                }
                SampleFormat::I16 => {
                    let samples_i16 = unsafe {
                        std::slice::from_raw_parts(
                            data.as_ptr() as *const i16,
                            data.len() / 2,
                        )
                    };
                    samples_i16.iter().map(|&s| s as f32 / i16::MAX as f32).collect()
                }
                SampleFormat::I32 => {
                    let samples_i32 = unsafe {
                        std::slice::from_raw_parts(
                            data.as_ptr() as *const i32,
                            data.len() / 4,
                        )
                    };
                    samples_i32.iter().map(|&s| s as f32 / i32::MAX as f32).collect()
                }
                SampleFormat::U8 => {
                    let samples_u8 = data.to_vec();
                    samples_u8.iter().map(|&s| (s as f32 - 128.0) / 128.0).collect()
                }
                _ => Vec::new(),
            };

            let mut buffer = buffer_clone.lock().unwrap();
            buffer.extend(&samples);

            let tx = sample_tx.clone();
            tokio::spawn(async move {
                let _ = tx.send(samples).await;
            });
        };

        let err_fn = |err| eprintln!("Audio stream error: {}", err);

        let stream = match config.sample_format() {
            SampleFormat::F32 => device.build_input_stream(&config.into(), stream_data_fn, err_fn, None)?,
            SampleFormat::I16 => device.build_input_stream(&config.into(), stream_data_fn, err_fn, None)?,
            SampleFormat::I32 => device.build_input_stream(&config.into(), stream_data_fn, err_fn, None)?,
            SampleFormat::U8 => device.build_input_stream(&config.into(), stream_data_fn, err_fn, None)?,
            _ => return Err("Unsupported sample format".into()),
        };

        stream.play()?;
        self._stream = Some(stream);

        Ok(())
    }

    pub fn get_sample_channel(&self) -> Option<tokio::sync::mpsc::Receiver<Vec<f32>>> {
        self.sample_tx.as_ref().map(|_| {
            let (tx, rx) = tokio::sync::mpsc::channel(100);
            let _tx = tx;
            rx
        })
    }
}
