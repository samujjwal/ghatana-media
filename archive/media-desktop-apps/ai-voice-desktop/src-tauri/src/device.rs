use cpal::traits::{DeviceTrait, HostTrait};

use crate::error::{AppError, AppResult};

pub struct DeviceSelection {
    pub device: cpal::Device,
    pub config: cpal::SupportedStreamConfig,
    pub name: String,
}

pub struct AudioDeviceManager;

impl AudioDeviceManager {
    pub fn default_input() -> AppResult<DeviceSelection> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| AppError::Audio("No input device available".to_string()))?;
        let name = device
            .name()
            .unwrap_or_else(|_| "unknown-input-device".to_string());
        let config = device.default_input_config().map_err(|error| {
            AppError::Audio(format!("Failed to get input config for {name}: {error}"))
        })?;
        Ok(DeviceSelection {
            device,
            config,
            name,
        })
    }

    pub fn default_output() -> AppResult<DeviceSelection> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| AppError::Audio("No output device available".to_string()))?;
        let name = device
            .name()
            .unwrap_or_else(|_| "unknown-output-device".to_string());
        let config = device.default_output_config().map_err(|error| {
            AppError::Audio(format!("Failed to get output config for {name}: {error}"))
        })?;
        Ok(DeviceSelection {
            device,
            config,
            name,
        })
    }
}