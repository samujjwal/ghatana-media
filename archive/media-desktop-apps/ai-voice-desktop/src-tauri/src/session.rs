use chrono::Utc;

use crate::models::{AudioSession, AudioSessionMode, AudioSessionState};

pub fn new_audio_session(
    source_path: String,
    project_id: Option<String>,
    mode: AudioSessionMode,
    duration_seconds: f64,
) -> AudioSession {
    AudioSession {
        id: uuid::Uuid::new_v4().to_string(),
        source_path,
        project_id,
        mode,
        state: AudioSessionState::Active,
        duration_seconds,
        created_at: Utc::now().to_rfc3339(),
        closed_at: None,
    }
}

pub fn close_audio_session(mut session: AudioSession) -> AudioSession {
    session.state = AudioSessionState::Closed;
    session.closed_at = Some(Utc::now().to_rfc3339());
    session
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_closes_audio_session() {
        let session = new_audio_session("track.wav".to_string(), None, AudioSessionMode::Edit, 1.25);
        assert_eq!(session.state, AudioSessionState::Active);
        let closed = close_audio_session(session);
        assert_eq!(closed.state, AudioSessionState::Closed);
        assert!(closed.closed_at.is_some());
    }
}