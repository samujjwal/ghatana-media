use std::sync::{Arc, Mutex};

pub struct SampleAccumulator {
    samples: Vec<i16>,
}

impl SampleAccumulator {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            samples: Vec::with_capacity(capacity),
        }
    }

    pub fn push_f32_frames(&mut self, data: &[f32], channels: usize) {
        for frame in data.chunks(channels.max(1)) {
            let sample = frame.first().copied().unwrap_or(0.0);
            self.samples
                .push((sample * 32767.0).clamp(-32768.0, 32767.0) as i16);
        }
    }

    pub fn push_i16_frames(&mut self, data: &[i16], channels: usize) {
        for frame in data.chunks(channels.max(1)) {
            self.samples.push(frame.first().copied().unwrap_or(0));
        }
    }

    pub fn push_u16_frames(&mut self, data: &[u16], channels: usize) {
        for frame in data.chunks(channels.max(1)) {
            let sample = frame.first().copied().unwrap_or(u16::MAX / 2);
            self.samples.push((sample as i32 - 32768) as i16);
        }
    }

    pub fn snapshot(&self) -> Vec<i16> {
        self.samples.clone()
    }
}

pub struct PlaybackCursor {
    samples: Arc<[f32]>,
    index: Mutex<usize>,
}

impl PlaybackCursor {
    pub fn new(samples: Vec<f32>) -> Self {
        Self {
            samples: Arc::from(samples.into_boxed_slice()),
            index: Mutex::new(0),
        }
    }

    pub fn fill_f32(&self, output: &mut [f32]) -> bool {
        self.fill(output, |value| value)
    }

    pub fn fill_i16(&self, output: &mut [i16]) -> bool {
        self.fill(output, |value| {
            (value * i16::MAX as f32)
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16
        })
    }

    pub fn fill_u16(&self, output: &mut [u16]) -> bool {
        self.fill(output, |value| {
            let i16_value = (value * i16::MAX as f32)
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            (i16_value as i32 + 32768) as u16
        })
    }

    fn fill<T, F>(&self, output: &mut [T], map: F) -> bool
    where
        F: Fn(f32) -> T,
        T: Default + Copy,
    {
        let mut index = self.index.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut finished = false;
        for value in output.iter_mut() {
            if *index < self.samples.len() {
                *value = map(self.samples[*index]);
                *index += 1;
            } else {
                *value = T::default();
                finished = true;
            }
        }
        finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulator_downmixes_first_channel() {
        let mut accumulator = SampleAccumulator::with_capacity(4);
        accumulator.push_i16_frames(&[1, 2, 3, 4], 2);
        assert_eq!(accumulator.snapshot(), vec![1, 3]);
    }

    #[test]
    fn playback_cursor_zero_fills_at_end() {
        let cursor = PlaybackCursor::new(vec![0.25, -0.25]);
        let mut output = [0.0f32; 4];
        let finished = cursor.fill_f32(&mut output);
        assert!(finished);
        assert_eq!(output[0], 0.25);
        assert_eq!(output[1], -0.25);
        assert_eq!(output[2], 0.0);
    }
}