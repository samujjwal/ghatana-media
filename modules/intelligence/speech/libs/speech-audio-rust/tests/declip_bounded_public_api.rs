use speech_audio_rust::{
    declip_bounded, AudioBuffer, AudioConfig, RepairLimits, SampleFormat, SpeechAudioError,
};

fn mono(samples: Vec<f32>) -> AudioBuffer {
    AudioBuffer::new(
        samples,
        AudioConfig {
            sample_rate: 8_000,
            channels: 1,
            sample_format: SampleFormat::F32,
        },
    )
}

#[test]
fn bounded_declip_obeys_configured_inclusive_run_limit_without_mutating_source() {
    let source = mono(vec![0.1, 0.99, 0.99, 0.1]);
    let original = source.clone();
    let limits = RepairLimits {
        max_declip_run_frames: 2,
        ..RepairLimits::DEFAULT
    };

    let repaired = declip_bounded(&source, 0.98, limits).unwrap();
    assert_eq!(repaired.samples, vec![0.1, 0.1, 0.1, 0.1]);
    assert_eq!(
        source, original,
        "bounded declip must leave the source unchanged"
    );

    let too_small_limits = RepairLimits {
        max_declip_run_frames: 1,
        ..RepairLimits::DEFAULT
    };
    assert!(matches!(
        declip_bounded(&source, 0.98, too_small_limits),
        Err(SpeechAudioError::InvalidInput(_))
    ));
    assert_eq!(
        source, original,
        "failed bounded declip must leave the source unchanged"
    );
}

#[test]
fn bounded_declip_enforces_reduced_sample_budget_and_crate_hard_cap() {
    let source = mono(vec![0.1, 0.2, 0.3, 0.4]);
    let original = source.clone();
    let reduced_budget = RepairLimits {
        max_samples: 3,
        ..RepairLimits::DEFAULT
    };

    assert!(matches!(
        declip_bounded(&source, 0.98, reduced_budget),
        Err(SpeechAudioError::ResourceLimit(_))
    ));
    assert_eq!(source, original);

    let over_hard_cap = RepairLimits {
        max_samples: RepairLimits::DEFAULT.max_samples + 1,
        ..RepairLimits::DEFAULT
    };
    assert!(matches!(
        declip_bounded(&source, 0.98, over_hard_cap),
        Err(SpeechAudioError::InvalidInput(_))
    ));
    assert_eq!(source, original);
}
