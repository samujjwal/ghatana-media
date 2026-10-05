use crate::models::{AvSyncAssessment, AvSyncQuality};
use crate::metrics::AudioRuntimeMetrics;

pub fn assess_sync(
    audio_duration_seconds: f64,
    video_duration_seconds: f64,
    audio_offset_ms: i64,
    video_offset_ms: i64,
    tolerance_ms: i64,
) -> AvSyncAssessment {
    let duration_drift_ms = ((audio_duration_seconds - video_duration_seconds) * 1000.0).round() as i64;
    let drift_ms = duration_drift_ms + audio_offset_ms - video_offset_ms;
    let absolute = drift_ms.abs();
    let quality = if absolute <= 20 {
        AvSyncQuality::Excellent
    } else if absolute <= tolerance_ms.max(40) {
        AvSyncQuality::Good
    } else if absolute <= 100 {
        AvSyncQuality::Fair
    } else {
        AvSyncQuality::Poor
    };
    let recommendation = if absolute <= tolerance_ms {
        "Audio and video are aligned within tolerance.".to_string()
    } else if drift_ms > 0 {
        format!("Audio leads video by {}ms; delay audio or drop early audio frames.", absolute)
    } else {
        format!("Video leads audio by {}ms; delay video or trim early video frames.", absolute)
    };

    AvSyncAssessment {
        audio_duration_seconds,
        video_duration_seconds,
        drift_ms,
        tolerance_ms,
        within_tolerance: absolute <= tolerance_ms,
        quality,
        recommendation,
    }
    .tap(|report| AudioRuntimeMetrics::global().record_sync_drift(report.drift_ms))
}

trait Tap: Sized {
    fn tap<F: FnOnce(&Self)>(self, func: F) -> Self {
        func(&self);
        self
    }
}

impl<T> Tap for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_assessment_marks_small_drift_as_good() {
        let report = assess_sync(10.0, 10.01, 0, 0, 40);
        assert!(report.within_tolerance);
        assert!(matches!(report.quality, AvSyncQuality::Excellent | AvSyncQuality::Good));
    }

    #[test]
    fn sync_assessment_recommends_fix_for_large_drift() {
        let report = assess_sync(10.5, 10.0, 30, 0, 40);
        assert!(!report.within_tolerance);
        assert_eq!(report.quality, AvSyncQuality::Poor);
    }
}