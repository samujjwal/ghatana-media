/// Security validation utilities for file uploads and data processing

use std::path::Path;

/// Maximum file sizes (in bytes)
pub const MAX_AUDIO_SIZE: usize = 100 * 1024 * 1024; // 100MB
pub const MAX_IMAGE_SIZE: usize = 50 * 1024 * 1024;  // 50MB
pub const MAX_VIDEO_SIZE: usize = 500 * 1024 * 1024; // 500MB
pub const MAX_TEXT_LENGTH: usize = 1_000_000; // 1M characters

/// Allowed file extensions
pub const ALLOWED_AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "ogg", "flac", "m4a"];
pub const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];
pub const ALLOWED_VIDEO_EXTENSIONS: &[&str] = &["mp4", "avi", "mov", "mkv", "webm"];

/// Validation error types
#[derive(Debug)]
pub enum ValidationError {
    FileTooLarge { size: usize, max: usize },
    InvalidExtension { extension: String, allowed: Vec<String> },
    InvalidFileType { detected: String, expected: String },
    TextTooLong { length: usize, max: usize },
    InvalidContent(String),
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::FileTooLarge { size, max } => {
                write!(f, "File size {} bytes exceeds maximum {} bytes", size, max)
            }
            ValidationError::InvalidExtension { extension, allowed } => {
                write!(f, "Extension '{}' not allowed. Allowed: {:?}", extension, allowed)
            }
            ValidationError::InvalidFileType { detected, expected } => {
                write!(f, "File type '{}' does not match expected '{}'", detected, expected)
            }
            ValidationError::TextTooLong { length, max } => {
                write!(f, "Text length {} exceeds maximum {}", length, max)
            }
            ValidationError::InvalidContent(msg) => write!(f, "Invalid content: {}", msg),
        }
    }
}

/// Validate audio file
pub fn validate_audio_file(data: &[u8], filename: Option<&str>) -> Result<(), ValidationError> {
    // Check size
    if data.len() > MAX_AUDIO_SIZE {
        return Err(ValidationError::FileTooLarge {
            size: data.len(),
            max: MAX_AUDIO_SIZE,
        });
    }
    
    // Check extension if filename provided
    if let Some(name) = filename {
        let extension = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        
        if !ALLOWED_AUDIO_EXTENSIONS.contains(&extension.to_lowercase().as_str()) {
            return Err(ValidationError::InvalidExtension {
                extension: extension.to_string(),
                allowed: ALLOWED_AUDIO_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
            });
        }
    }
    
    // Validate file signature (magic bytes)
    validate_audio_signature(data)?;
    
    Ok(())
}

/// Validate image file
pub fn validate_image_file(data: &[u8], filename: Option<&str>) -> Result<(), ValidationError> {
    // Check size
    if data.len() > MAX_IMAGE_SIZE {
        return Err(ValidationError::FileTooLarge {
            size: data.len(),
            max: MAX_IMAGE_SIZE,
        });
    }
    
    // Check extension if filename provided
    if let Some(name) = filename {
        let extension = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        
        if !ALLOWED_IMAGE_EXTENSIONS.contains(&extension.to_lowercase().as_str()) {
            return Err(ValidationError::InvalidExtension {
                extension: extension.to_string(),
                allowed: ALLOWED_IMAGE_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
            });
        }
    }
    
    // Validate file signature (magic bytes)
    validate_image_signature(data)?;
    
    Ok(())
}

/// Validate video file
pub fn validate_video_file(data: &[u8], filename: Option<&str>) -> Result<(), ValidationError> {
    // Check size
    if data.len() > MAX_VIDEO_SIZE {
        return Err(ValidationError::FileTooLarge {
            size: data.len(),
            max: MAX_VIDEO_SIZE,
        });
    }
    
    // Check extension if filename provided
    if let Some(name) = filename {
        let extension = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        
        if !ALLOWED_VIDEO_EXTENSIONS.contains(&extension.to_lowercase().as_str()) {
            return Err(ValidationError::InvalidExtension {
                extension: extension.to_string(),
                allowed: ALLOWED_VIDEO_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
            });
        }
    }
    
    // Validate file signature (magic bytes)
    validate_video_signature(data)?;
    
    Ok(())
}

/// Validate text input
pub fn validate_text(text: &str) -> Result<(), ValidationError> {
    if text.len() > MAX_TEXT_LENGTH {
        return Err(ValidationError::TextTooLong {
            length: text.len(),
            max: MAX_TEXT_LENGTH,
        });
    }
    
    // Check for null bytes or other invalid characters
    if text.contains('\0') {
        return Err(ValidationError::InvalidContent("Text contains null bytes".to_string()));
    }
    
    Ok(())
}

/// Validate audio file signature (magic bytes)
fn validate_audio_signature(data: &[u8]) -> Result<(), ValidationError> {
    if data.len() < 4 {
        return Err(ValidationError::InvalidContent("File too small".to_string()));
    }
    
    // Check for common audio file signatures
    let is_valid = 
        // WAV: "RIFF"
        (data.starts_with(b"RIFF") && data.len() > 8 && &data[8..12] == b"WAVE") ||
        // MP3: ID3 or FF FB/FF F3/FF F2
        data.starts_with(b"ID3") ||
        (data[0] == 0xFF && (data[1] & 0xE0) == 0xE0) ||
        // OGG: "OggS"
        data.starts_with(b"OggS") ||
        // FLAC: "fLaC"
        data.starts_with(b"fLaC") ||
        // M4A: "ftyp"
        (data.len() > 8 && &data[4..8] == b"ftyp");
    
    if !is_valid {
        return Err(ValidationError::InvalidFileType {
            detected: "unknown".to_string(),
            expected: "audio".to_string(),
        });
    }
    
    Ok(())
}

/// Validate image file signature (magic bytes)
fn validate_image_signature(data: &[u8]) -> Result<(), ValidationError> {
    if data.len() < 4 {
        return Err(ValidationError::InvalidContent("File too small".to_string()));
    }
    
    // Check for common image file signatures
    let is_valid = 
        // JPEG: FF D8 FF
        (data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) ||
        // PNG: 89 50 4E 47
        data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) ||
        // GIF: "GIF87a" or "GIF89a"
        data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") ||
        // WebP: "RIFF" + "WEBP"
        (data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP") ||
        // BMP: "BM"
        data.starts_with(b"BM");
    
    if !is_valid {
        return Err(ValidationError::InvalidFileType {
            detected: "unknown".to_string(),
            expected: "image".to_string(),
        });
    }
    
    Ok(())
}

/// Validate video file signature (magic bytes)
fn validate_video_signature(data: &[u8]) -> Result<(), ValidationError> {
    if data.len() < 12 {
        return Err(ValidationError::InvalidContent("File too small".to_string()));
    }
    
    // Check for common video file signatures
    let is_valid = 
        // MP4: "ftyp"
        &data[4..8] == b"ftyp" ||
        // AVI: "RIFF" + "AVI "
        (data.starts_with(b"RIFF") && &data[8..12] == b"AVI ") ||
        // MOV: "ftyp" or "moov"
        &data[4..8] == b"moov" ||
        // MKV/WebM: EBML signature
        data.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]);
    
    if !is_valid {
        return Err(ValidationError::InvalidFileType {
            detected: "unknown".to_string(),
            expected: "video".to_string(),
        });
    }
    
    Ok(())
}

/// Sanitize filename to prevent path traversal
pub fn sanitize_filename(filename: &str) -> String {
    filename
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// Minimal WAV header: "RIFF" + 4-byte size + "WAVE"
    fn wav_bytes() -> Vec<u8> {
        let mut v = Vec::with_capacity(12);
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(0u32).to_le_bytes()); // chunk size
        v.extend_from_slice(b"WAVE");
        v
    }

    /// MP3 ID3 header
    fn mp3_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..3].copy_from_slice(b"ID3");
        v
    }

    /// Ogg header
    fn ogg_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..4].copy_from_slice(b"OggS");
        v
    }

    /// FLAC header
    fn flac_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..4].copy_from_slice(b"fLaC");
        v
    }

    /// PNG header
    fn png_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..4].copy_from_slice(&[0x89, 0x50, 0x4E, 0x47]);
        v
    }

    /// JPEG header
    fn jpeg_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        v
    }

    /// BMP header
    fn bmp_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..2].copy_from_slice(b"BM");
        v
    }

    /// WebP: "RIFF" + 4-byte size + "WEBP"
    fn webp_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..4].copy_from_slice(b"RIFF");
        v[8..12].copy_from_slice(b"WEBP");
        v
    }

    /// MP4: 4 zero bytes + "ftyp"
    fn mp4_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[4..8].copy_from_slice(b"ftyp");
        v
    }

    /// AVI: "RIFF" + 4-byte size + "AVI "
    fn avi_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..4].copy_from_slice(b"RIFF");
        v[8..12].copy_from_slice(b"AVI ");
        v
    }

    /// MKV/WebM EBML
    fn mkv_bytes() -> Vec<u8> {
        let mut v = vec![0u8; 16];
        v[..4].copy_from_slice(&[0x1A, 0x45, 0xDF, 0xA3]);
        v
    }

    // ─── validate_text ────────────────────────────────────────────────────────

    #[test]
    fn test_validate_text_ok() {
        assert!(validate_text("Hello, world!").is_ok());
    }

    #[test]
    fn test_validate_text_empty_ok() {
        assert!(validate_text("").is_ok());
    }

    #[test]
    fn test_validate_text_too_long() {
        let result = validate_text(&"a".repeat(MAX_TEXT_LENGTH + 1));
        assert!(matches!(result, Err(ValidationError::TextTooLong { .. })));
    }

    #[test]
    fn test_validate_text_null_byte() {
        let result = validate_text("Text with\0null byte");
        assert!(matches!(result, Err(ValidationError::InvalidContent(_))));
    }

    #[test]
    fn test_validate_text_exactly_at_limit_ok() {
        let text = "a".repeat(MAX_TEXT_LENGTH);
        assert!(validate_text(&text).is_ok());
    }

    // ─── sanitize_filename ────────────────────────────────────────────────────

    #[test]
    fn test_sanitize_filename_path_traversal() {
        assert_eq!(sanitize_filename("../../../etc/passwd"), "etcpasswd");
    }

    #[test]
    fn test_sanitize_filename_spaces_removed() {
        assert_eq!(sanitize_filename("file name.txt"), "filename.txt");
    }

    #[test]
    fn test_sanitize_filename_valid_unchanged() {
        assert_eq!(sanitize_filename("valid-file_123.mp3"), "valid-file_123.mp3");
    }

    #[test]
    fn test_sanitize_filename_empty() {
        assert_eq!(sanitize_filename(""), "");
    }

    #[test]
    fn test_sanitize_filename_special_chars_removed() {
        assert_eq!(sanitize_filename("file!@#$%^&*().mp3"), "file.mp3");
    }

    // ─── validate_audio_file ──────────────────────────────────────────────────

    #[test]
    fn test_validate_audio_wav_ok() {
        assert!(validate_audio_file(&wav_bytes(), Some("audio.wav")).is_ok());
    }

    #[test]
    fn test_validate_audio_mp3_ok() {
        assert!(validate_audio_file(&mp3_bytes(), Some("track.mp3")).is_ok());
    }

    #[test]
    fn test_validate_audio_ogg_ok() {
        assert!(validate_audio_file(&ogg_bytes(), Some("sound.ogg")).is_ok());
    }

    #[test]
    fn test_validate_audio_flac_ok() {
        assert!(validate_audio_file(&flac_bytes(), Some("music.flac")).is_ok());
    }

    #[test]
    fn test_validate_audio_no_filename_ok() {
        // Without filename, extension check is skipped
        assert!(validate_audio_file(&wav_bytes(), None).is_ok());
    }

    #[test]
    fn test_validate_audio_invalid_extension() {
        let result = validate_audio_file(&wav_bytes(), Some("audio.exe"));
        assert!(matches!(result, Err(ValidationError::InvalidExtension { .. })));
    }

    #[test]
    fn test_validate_audio_uppercase_extension_rejected() {
        // Extension check is case-folded; "WAV" should be accepted as "wav"
        assert!(validate_audio_file(&wav_bytes(), Some("audio.WAV")).is_ok());
    }

    #[test]
    fn test_validate_audio_file_too_large() {
        // Build a Vec that exceeds MAX_AUDIO_SIZE in reported length via a trick:
        // We need a real large slice — use a proxy that triggers the size check.
        // Since allocating 100 MB in tests is wasteful, we test the error
        // variant directly via a crafted slice address trick is not possible,
        // so we verify the constant and the error shape documentation instead.
        assert!(MAX_AUDIO_SIZE > 0);
        // Verify that a truly oversized buffer would hit the right branch:
        // (this is a lightweight guard — integration tests or property tests
        // should cover the actual 100 MB threshold)
        let too_big: Vec<u8> = vec![0xFF; MAX_AUDIO_SIZE + 1];
        let result = validate_audio_file(&too_big, None);
        assert!(matches!(result, Err(ValidationError::FileTooLarge { .. })));
    }

    #[test]
    fn test_validate_audio_invalid_signature() {
        let invalid: Vec<u8> = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        let result = validate_audio_file(&invalid, None);
        assert!(matches!(result, Err(ValidationError::InvalidFileType { .. })));
    }

    #[test]
    fn test_validate_audio_too_small() {
        // 2 bytes — too small for any signature
        let tiny: Vec<u8> = vec![0xFF, 0xE0];
        let result = validate_audio_file(&tiny, None);
        assert!(matches!(result, Err(ValidationError::InvalidContent(_))));
    }

    // ─── validate_image_file ──────────────────────────────────────────────────

    #[test]
    fn test_validate_image_png_ok() {
        assert!(validate_image_file(&png_bytes(), Some("photo.png")).is_ok());
    }

    #[test]
    fn test_validate_image_jpeg_ok() {
        assert!(validate_image_file(&jpeg_bytes(), Some("photo.jpg")).is_ok());
    }

    #[test]
    fn test_validate_image_bmp_ok() {
        assert!(validate_image_file(&bmp_bytes(), Some("image.bmp")).is_ok());
    }

    #[test]
    fn test_validate_image_webp_ok() {
        assert!(validate_image_file(&webp_bytes(), Some("image.webp")).is_ok());
    }

    #[test]
    fn test_validate_image_invalid_extension() {
        let result = validate_image_file(&png_bytes(), Some("image.mp3"));
        assert!(matches!(result, Err(ValidationError::InvalidExtension { .. })));
    }

    #[test]
    fn test_validate_image_no_filename_ok() {
        assert!(validate_image_file(&jpeg_bytes(), None).is_ok());
    }

    #[test]
    fn test_validate_image_invalid_signature() {
        let invalid: Vec<u8> = vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        let result = validate_image_file(&invalid, None);
        assert!(matches!(result, Err(ValidationError::InvalidFileType { .. })));
    }

    #[test]
    fn test_validate_image_too_small() {
        let tiny: Vec<u8> = vec![0x89, 0x50];
        let result = validate_image_file(&tiny, None);
        assert!(matches!(result, Err(ValidationError::InvalidContent(_))));
    }

    // ─── validate_video_file ──────────────────────────────────────────────────

    #[test]
    fn test_validate_video_mp4_ok() {
        assert!(validate_video_file(&mp4_bytes(), Some("video.mp4")).is_ok());
    }

    #[test]
    fn test_validate_video_avi_ok() {
        assert!(validate_video_file(&avi_bytes(), Some("clip.avi")).is_ok());
    }

    #[test]
    fn test_validate_video_mkv_ok() {
        assert!(validate_video_file(&mkv_bytes(), Some("film.mkv")).is_ok());
    }

    #[test]
    fn test_validate_video_no_filename_ok() {
        assert!(validate_video_file(&mp4_bytes(), None).is_ok());
    }

    #[test]
    fn test_validate_video_invalid_extension() {
        let result = validate_video_file(&mp4_bytes(), Some("video.txt"));
        assert!(matches!(result, Err(ValidationError::InvalidExtension { .. })));
    }

    #[test]
    fn test_validate_video_too_small() {
        let tiny: Vec<u8> = vec![0x00; 4];
        let result = validate_video_file(&tiny, None);
        assert!(matches!(result, Err(ValidationError::InvalidContent(_))));
    }

    #[test]
    fn test_validate_video_invalid_signature() {
        let invalid: Vec<u8> = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        let result = validate_video_file(&invalid, None);
        assert!(matches!(result, Err(ValidationError::InvalidFileType { .. })));
    }

    // ─── ValidationError Display ──────────────────────────────────────────────

    #[test]
    fn test_validation_error_display_file_too_large() {
        let e = ValidationError::FileTooLarge { size: 200, max: 100 };
        let msg = format!("{}", e);
        assert!(msg.contains("200"));
        assert!(msg.contains("100"));
    }

    #[test]
    fn test_validation_error_display_invalid_extension() {
        let e = ValidationError::InvalidExtension {
            extension: "exe".to_string(),
            allowed: vec!["wav".to_string(), "mp3".to_string()],
        };
        let msg = format!("{}", e);
        assert!(msg.contains("exe"));
        assert!(msg.contains("wav"));
    }

    #[test]
    fn test_validation_error_display_invalid_file_type() {
        let e = ValidationError::InvalidFileType {
            detected: "unknown".to_string(),
            expected: "audio".to_string(),
        };
        let msg = format!("{}", e);
        assert!(msg.contains("audio"));
    }

    #[test]
    fn test_validation_error_display_text_too_long() {
        let e = ValidationError::TextTooLong { length: 2_000_000, max: 1_000_000 };
        let msg = format!("{}", e);
        assert!(msg.contains("2000000"));
    }

    #[test]
    fn test_validation_error_display_invalid_content() {
        let e = ValidationError::InvalidContent("null bytes found".to_string());
        let msg = format!("{}", e);
        assert!(msg.contains("null bytes found"));
    }
}
