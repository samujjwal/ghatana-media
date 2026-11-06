use speech_audio_rust::{compare_audio, AudioBuffer, AudioConfig, SampleFormat};

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
fn comparison_snapshots_metrics_and_undo_remain_bound_to_the_original_bytes() {
    let source = mono(vec![0.1, 0.2, 0.3, 0.4]);
    let repaired = mono(vec![0.1, 0.18, 0.27, 0.4]);
    let expected_source = source.clone();
    let comparison = compare_audio(&source, &repaired, None).unwrap();
    let expected_changed_count = comparison.metrics().changed_sample_count;

    let mut undo = comparison.undo().unwrap();
    undo.samples.fill(-0.75);

    assert_eq!(
        source, expected_source,
        "repair must not mutate caller input"
    );
    assert_eq!(comparison.source(), &expected_source);
    assert_eq!(comparison.repaired(), &repaired);
    assert_eq!(
        comparison.metrics().changed_sample_count,
        expected_changed_count
    );
    assert_eq!(comparison.undo().unwrap(), expected_source);
}
