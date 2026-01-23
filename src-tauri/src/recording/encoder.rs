use std::io::BufWriter;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::recording::state::RecordingConfig;

pub struct WavEncoder {
    writer: Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>,
    sample_rate: u32,
    channels: u16,
    config: RecordingConfig,
}

impl WavEncoder {
    pub fn new(output_path: &Path, config: RecordingConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let spec = hound::WavSpec {
            channels: config.channels,
            sample_rate: config.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let file = std::fs::File::create(output_path)?;
        let writer = hound::WavWriter::new(BufWriter::new(file), spec)?;

        Ok(Self {
            writer: Some(writer),
            sample_rate: config.sample_rate,
            channels: config.channels,
            config,
        })
    }

    pub fn write_samples(&mut self, samples: &[f32]) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(ref mut writer) = self.writer {
            for &sample in samples {
                let int_sample = (sample * i16::MAX as f32) as i16;
                writer.write_sample(int_sample)?;
            }
        }
        Ok(())
    }

    pub fn finalize(mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(writer) = self.writer.take() {
            writer.finalize()?;
        }
        Ok(())
    }
}

pub type AsyncEncoder = Arc<Mutex<Option<WavEncoder>>>;

pub async fn start_encoder(
    output_path: &Path,
    config: RecordingConfig,
) -> Result<AsyncEncoder, Box<dyn std::error::Error>> {
    let encoder = WavEncoder::new(output_path, config)?;
    Ok(Arc::new(Mutex::new(Some(encoder))))
}

pub async fn write_to_encoder(encoder: &AsyncEncoder, samples: &[f32]) -> Result<(), String> {
    let mut guard = encoder.lock().await;
    if let Some(ref mut enc) = *guard {
        enc.write_samples(samples)
            .map_err(|e| format!("Failed to write samples: {}", e))?;
    }
    Ok(())
}

pub async fn finalize_encoder(encoder: AsyncEncoder) -> Result<(), String> {
    let mut guard = encoder.lock().await;
    if let Some(enc) = guard.take() {
        enc.finalize()
            .map_err(|e| format!("Failed to finalize encoder: {}", e))?;
    }
    Ok(())
}
