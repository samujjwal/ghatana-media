/**
 * Project Storage Backend
 *
 * Handles project persistence:
 * - Save/load projects
 * - Export mixdowns
 * - Cloud sync (optional)
 * - Version control
 *
 * @doc.type module
 * @doc.purpose Project persistence
 * @doc.layer backend
 */

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use chrono::{DateTime, Utc};
use uuid::Uuid;
use anyhow::{Context, Result};
use serde_json;
use speech_audio_rust::{write_wav, AudioBuffer};

use crate::audio::load_wav_as_audio_buffer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTrack {
    pub id: String,
    pub name: String,
    pub audio_path: String,
    pub volume: f32,       // 0.0-1.0
    pub pan: f32,          // -1.0 to 1.0
    pub muted: bool,
    pub solo: bool,
    pub color: String,
    pub effects: Vec<Effect>,
    pub start_time: f64,   // seconds
    pub duration: f64,     // seconds
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Effect {
    pub id: String,
    pub effect_type: String,
    pub enabled: bool,
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSettings {
    pub sample_rate: u32,
    pub bit_depth: u32,
    pub tempo: f32,
    pub time_signature: (u32, u32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMetadata {
    pub author: String,
    pub description: String,
    pub tags: Vec<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub tracks: Vec<AudioTrack>,
    pub settings: ProjectSettings,
    pub metadata: ProjectMetadata,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            sample_rate: 44100,
            bit_depth: 24,
            tempo: 120.0,
            time_signature: (4, 4),
        }
    }
}

impl Default for ProjectMetadata {
    fn default() -> Self {
        Self {
            author: String::from("Unknown"),
            description: String::new(),
            tags: Vec::new(),
            version: String::from("1.0.0"),
        }
    }
}

impl Project {
    pub fn new(name: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            created: now,
            modified: now,
            tracks: Vec::new(),
            settings: ProjectSettings::default(),
            metadata: ProjectMetadata::default(),
        }
    }

    pub fn add_track(&mut self, track: AudioTrack) {
        self.tracks.push(track);
        self.modified = Utc::now();
    }

    pub fn remove_track(&mut self, track_id: &str) {
        self.tracks.retain(|t| t.id != track_id);
        self.modified = Utc::now();
    }

    pub fn update_track(&mut self, track: AudioTrack) {
        if let Some(existing) = self.tracks.iter_mut().find(|t| t.id == track.id) {
            *existing = track;
            self.modified = Utc::now();
        }
    }
}

pub struct ProjectStorage {
    storage_dir: PathBuf,
}

impl ProjectStorage {
    pub fn new(storage_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&storage_dir)
            .context("Failed to create storage directory")?;

        Ok(Self { storage_dir })
    }

    pub fn save_project(&self, project: &Project) -> Result<PathBuf> {
        let project_dir = self.storage_dir.join(&project.id);
        fs::create_dir_all(&project_dir)
            .context("Failed to create project directory")?;

        // Save project metadata
        let project_file = project_dir.join("project.json");
        let json = serde_json::to_string_pretty(project)
            .context("Failed to serialize project")?;

        fs::write(&project_file, json)
            .context("Failed to write project file")?;

        // Copy audio files to project directory
        let audio_dir = project_dir.join("audio");
        fs::create_dir_all(&audio_dir)?;

        for track in &project.tracks {
            if !track.audio_path.is_empty() {
                let source = Path::new(&track.audio_path);
                if source.exists() {
                    let filename = source.file_name().unwrap_or_default();
                    let dest = audio_dir.join(filename);

                    if !dest.exists() {
                        fs::copy(source, &dest)
                            .context(format!("Failed to copy audio file: {:?}", source))?;
                    }
                }
            }
        }

        Ok(project_file)
    }

    pub fn load_project(&self, project_id: &str) -> Result<Project> {
        let project_file = self.storage_dir
            .join(project_id)
            .join("project.json");

        let json = fs::read_to_string(&project_file)
            .context("Failed to read project file")?;

        let mut project: Project = serde_json::from_str(&json)
            .context("Failed to parse project file")?;

        // Update audio paths to absolute paths
        let audio_dir = self.storage_dir
            .join(project_id)
            .join("audio");

        for track in &mut project.tracks {
            if !track.audio_path.is_empty() {
                let filename = Path::new(&track.audio_path)
                    .file_name()
                    .unwrap_or_default();
                let absolute_path = audio_dir.join(filename);
                track.audio_path = absolute_path.to_string_lossy().to_string();
            }
        }

        Ok(project)
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectInfo>> {
        let mut projects = Vec::new();

        for entry in fs::read_dir(&self.storage_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                let project_file = path.join("project.json");
                if project_file.exists() {
                    let json = fs::read_to_string(&project_file)?;
                    let project: Project = serde_json::from_str(&json)?;

                    projects.push(ProjectInfo {
                        id: project.id,
                        name: project.name,
                        created: project.created,
                        modified: project.modified,
                        track_count: project.tracks.len(),
                    });
                }
            }
        }

        // Sort by modified date (newest first)
        projects.sort_by(|a, b| b.modified.cmp(&a.modified));

        Ok(projects)
    }

    pub fn delete_project(&self, project_id: &str) -> Result<()> {
        let project_dir = self.storage_dir.join(project_id);

        if project_dir.exists() {
            fs::remove_dir_all(&project_dir)
                .context("Failed to delete project directory")?;
        }

        Ok(())
    }

    pub fn export_project(
        &self,
        project_id: &str,
        export_path: &Path,
    ) -> Result<PathBuf> {
        let project = self.load_project(project_id)?;

        fs::create_dir_all(export_path)
            .context("Failed to create export directory")?;

        let mixdown = render_mixdown(&project)?;
        let output_path = export_path.join(format!("{}.wav", project.name));
        write_wav(&output_path, &mixdown)
            .context("Failed to write rendered mixdown")?;

        Ok(output_path)
    }

    pub fn get_storage_size(&self) -> Result<u64> {
        fn dir_size(path: &Path) -> Result<u64> {
            let mut size = 0;
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let metadata = entry.metadata()?;
                if metadata.is_dir() {
                    size += dir_size(&entry.path())?;
                } else {
                    size += metadata.len();
                }
            }
            Ok(size)
        }

        let total = dir_size(&self.storage_dir)?;

        Ok(total)
    }
}

fn render_mixdown(project: &Project) -> Result<AudioBuffer> {
    let active_tracks = collect_export_tracks(project)?;
    if active_tracks.is_empty() {
        anyhow::bail!("No active tracks to export")
    }

    let mut rendered_tracks: Vec<AudioBuffer> = Vec::with_capacity(active_tracks.len());
    let mut reference_config = None;

    for track in active_tracks {
        let mut buffer = load_wav_as_audio_buffer(&track.audio_path)
            .with_context(|| format!("Failed to load track '{}' for export", track.name))?;

        match reference_config {
            None => reference_config = Some(buffer.config),
            Some(config) if config != buffer.config => {
                anyhow::bail!(
                    "Track '{}' has sample rate/channels {:?}, expected {:?}",
                    track.name,
                    buffer.config,
                    config
                )
            }
            _ => {}
        }

        apply_track_gain(&mut buffer, track.volume);
        let shifted = apply_track_offset(buffer, track.start_time.max(0.0));
        rendered_tracks.push(shifted);
    }

    let config = reference_config.context("No reference audio configuration available")?;
    let max_samples = rendered_tracks
        .iter()
        .map(|buffer| buffer.samples.len())
        .max()
        .unwrap_or(0);
    let mut mixed = vec![0.0f32; max_samples];

    for buffer in &rendered_tracks {
        for (index, sample) in buffer.samples.iter().copied().enumerate() {
            mixed[index] += sample;
        }
    }

    normalize_samples(&mut mixed);

    Ok(AudioBuffer::new(mixed, config))
}

fn collect_export_tracks(project: &Project) -> Result<Vec<&AudioTrack>> {
    let soloed_tracks: Vec<&AudioTrack> = project
        .tracks
        .iter()
        .filter(|track| track.solo && !track.muted && !track.audio_path.is_empty())
        .collect();
    let candidate_tracks = if soloed_tracks.is_empty() {
        project
            .tracks
            .iter()
            .filter(|track| !track.muted && !track.audio_path.is_empty())
            .collect()
    } else {
        soloed_tracks
    };

    for track in &candidate_tracks {
        let path = Path::new(&track.audio_path);
        if !path.exists() {
            anyhow::bail!("Track '{}' references missing audio file '{}'.", track.name, track.audio_path)
        }
    }

    Ok(candidate_tracks)
}

fn apply_track_gain(buffer: &mut AudioBuffer, volume: f32) {
    let gain = volume.max(0.0);
    for sample in &mut buffer.samples {
        *sample *= gain;
    }
}

fn apply_track_offset(buffer: AudioBuffer, start_time_seconds: f64) -> AudioBuffer {
    let channels = buffer.config.channels.max(1) as usize;
    let offset_frames = (start_time_seconds * buffer.config.sample_rate as f64).round() as usize;
    let offset_samples = offset_frames.saturating_mul(channels);
    if offset_samples == 0 {
        return buffer;
    }

    let mut shifted = vec![0.0f32; offset_samples + buffer.samples.len()];
    shifted[offset_samples..].copy_from_slice(&buffer.samples);
    AudioBuffer::new(shifted, buffer.config)
}

fn normalize_samples(samples: &mut [f32]) {
    let peak = samples
        .iter()
        .copied()
        .fold(0.0f32, |max_peak, sample| max_peak.max(sample.abs()));
    if peak > 1.0 {
        for sample in samples {
            *sample /= peak;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub track_count: usize,
}

// Tauri command handlers
#[tauri::command]
pub async fn save_project(
    project: Project,
    storage_dir: String,
) -> Result<String, String> {
    let storage = ProjectStorage::new(PathBuf::from(storage_dir))
        .map_err(|e| e.to_string())?;

    let project_file = storage.save_project(&project)
        .map_err(|e| e.to_string())?;

    Ok(project_file.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn load_project(
    project_id: String,
    storage_dir: String,
) -> Result<Project, String> {
    let storage = ProjectStorage::new(PathBuf::from(storage_dir))
        .map_err(|e| e.to_string())?;

    storage.load_project(&project_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_projects(
    storage_dir: String,
) -> Result<Vec<ProjectInfo>, String> {
    let storage = ProjectStorage::new(PathBuf::from(storage_dir))
        .map_err(|e| e.to_string())?;

    storage.list_projects()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_project(
    project_id: String,
    storage_dir: String,
) -> Result<(), String> {
    let storage = ProjectStorage::new(PathBuf::from(storage_dir))
        .map_err(|e| e.to_string())?;

    storage.delete_project(&project_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_project(
    project_id: String,
    export_path: String,
    storage_dir: String,
) -> Result<String, String> {
    let storage = ProjectStorage::new(PathBuf::from(storage_dir))
        .map_err(|e| e.to_string())?;

    let output_path = storage.export_project(&project_id, Path::new(&export_path))
        .map_err(|e| e.to_string())?;

    Ok(output_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
    use tempfile::TempDir;

    fn write_test_wav(path: &Path, samples: &[f32], sample_rate: u32) {
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn read_test_wav(path: &Path) -> Vec<f32> {
        let mut reader = WavReader::open(path).unwrap();
        reader.samples::<f32>().map(|sample| sample.unwrap()).collect()
    }

    #[test]
    fn test_create_project() {
        let project = Project::new("Test Project".to_string());
        assert_eq!(project.name, "Test Project");
        assert_eq!(project.tracks.len(), 0);
    }

    #[test]
    fn test_save_load_project() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ProjectStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let mut project = Project::new("Test".to_string());
        project.add_track(AudioTrack {
            id: "track1".to_string(),
            name: "Track 1".to_string(),
            audio_path: String::new(),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            color: "#ff0000".to_string(),
            effects: Vec::new(),
            start_time: 0.0,
            duration: 10.0,
        });

        storage.save_project(&project).unwrap();

        let loaded = storage.load_project(&project.id).unwrap();
        assert_eq!(loaded.name, project.name);
        assert_eq!(loaded.tracks.len(), 1);
    }

    #[test]
    fn test_list_projects() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ProjectStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let project1 = Project::new("Project 1".to_string());
        let project2 = Project::new("Project 2".to_string());

        storage.save_project(&project1).unwrap();
        storage.save_project(&project2).unwrap();

        let projects = storage.list_projects().unwrap();
        assert_eq!(projects.len(), 2);
    }

    #[test]
    fn test_delete_project() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ProjectStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let project = Project::new("Test".to_string());
        storage.save_project(&project).unwrap();

        storage.delete_project(&project.id).unwrap();

        let projects = storage.list_projects().unwrap();
        assert_eq!(projects.len(), 0);
    }

    #[test]
    fn test_export_project_renders_mixdown_with_offsets_and_volume() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ProjectStorage::new(temp_dir.path().join("storage")).unwrap();
        let source_dir = temp_dir.path().join("sources");
        fs::create_dir_all(&source_dir).unwrap();

        let track_one_path = source_dir.join("track1.wav");
        let track_two_path = source_dir.join("track2.wav");
        write_test_wav(&track_one_path, &[0.5, 0.5], 1);
        write_test_wav(&track_two_path, &[1.0, 1.0], 1);

        let mut project = Project::new("Mixdown".to_string());
        project.add_track(AudioTrack {
            id: "track1".to_string(),
            name: "Track 1".to_string(),
            audio_path: track_one_path.to_string_lossy().to_string(),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            color: "#ff0000".to_string(),
            effects: Vec::new(),
            start_time: 0.0,
            duration: 2.0,
        });
        project.add_track(AudioTrack {
            id: "track2".to_string(),
            name: "Track 2".to_string(),
            audio_path: track_two_path.to_string_lossy().to_string(),
            volume: 0.5,
            pan: 0.0,
            muted: false,
            solo: false,
            color: "#00ff00".to_string(),
            effects: Vec::new(),
            start_time: 1.0,
            duration: 2.0,
        });

        storage.save_project(&project).unwrap();

        let export_dir = temp_dir.path().join("export");
        let output = storage.export_project(&project.id, &export_dir).unwrap();
        let samples = read_test_wav(&output);

        assert_eq!(samples, vec![0.5, 1.0, 0.5]);
    }

    #[test]
    fn test_export_project_honors_solo_tracks() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ProjectStorage::new(temp_dir.path().join("storage")).unwrap();
        let source_dir = temp_dir.path().join("sources");
        fs::create_dir_all(&source_dir).unwrap();

        let muted_out_path = source_dir.join("ignored.wav");
        let solo_path = source_dir.join("solo.wav");
        write_test_wav(&muted_out_path, &[0.25, 0.25], 1);
        write_test_wav(&solo_path, &[0.8, 0.4], 1);

        let mut project = Project::new("Solo".to_string());
        project.add_track(AudioTrack {
            id: "track1".to_string(),
            name: "Ignored".to_string(),
            audio_path: muted_out_path.to_string_lossy().to_string(),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            color: "#ff0000".to_string(),
            effects: Vec::new(),
            start_time: 0.0,
            duration: 2.0,
        });
        project.add_track(AudioTrack {
            id: "track2".to_string(),
            name: "Solo".to_string(),
            audio_path: solo_path.to_string_lossy().to_string(),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: true,
            color: "#00ff00".to_string(),
            effects: Vec::new(),
            start_time: 0.0,
            duration: 2.0,
        });

        storage.save_project(&project).unwrap();

        let export_dir = temp_dir.path().join("export");
        let output = storage.export_project(&project.id, &export_dir).unwrap();
        let samples = read_test_wav(&output);

        assert_eq!(samples, vec![0.8, 0.4]);
    }
}

