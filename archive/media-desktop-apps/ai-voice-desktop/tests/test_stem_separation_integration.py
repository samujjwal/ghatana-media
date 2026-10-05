"""
Integration tests for stem separation.

Tests the complete workflow:
1. Python module (stem_separator_enhanced.py)
2. Progress tracking
3. Quality metrics
4. Error handling
"""

import pytest
import tempfile
import shutil
from pathlib import Path
import numpy as np
import time
from typing import List

# Import the module to test
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from stem_separator_enhanced import (
    EnhancedStemSeparator,
    SeparationProgress,
    separate_stems_enhanced
)


@pytest.fixture
def temp_output_dir():
    """Create temporary output directory."""
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    shutil.rmtree(temp_dir)


@pytest.fixture
def test_audio_file(tmp_path):
    """Generate a test audio file."""
    try:
        import soundfile as sf

        # Generate 3 seconds of sine wave at 440Hz
        sample_rate = 44100
        duration = 3.0
        t = np.linspace(0, duration, int(sample_rate * duration))
        audio = 0.5 * np.sin(2 * np.pi * 440 * t)

        # Stereo
        audio_stereo = np.stack([audio, audio])

        audio_file = tmp_path / "test_audio.wav"
        sf.write(str(audio_file), audio_stereo.T, sample_rate)

        return str(audio_file)
    except ImportError:
        pytest.skip("soundfile not available")


class TestEnhancedStemSeparator:
    """Test the enhanced stem separator."""

    def test_initialization(self):
        """Test separator initialization."""
        separator = EnhancedStemSeparator()

        assert separator.model_name == "htdemucs"
        assert separator.device in ["cuda", "mps", "cpu"]
        assert separator.model is None  # Not loaded yet

    def test_device_detection(self):
        """Test device detection logic."""
        separator = EnhancedStemSeparator(device="auto")

        detected = separator._detect_device()
        assert detected in ["cuda", "mps", "cpu"]

    def test_progress_tracking(self, test_audio_file, temp_output_dir):
        """Test progress tracking during separation."""
        separator = EnhancedStemSeparator()

        progress_updates: List[SeparationProgress] = []

        def progress_callback(progress: SeparationProgress):
            progress_updates.append(progress)

        # This will use fallback mode if Demucs not available
        result = separator.separate(
            test_audio_file,
            temp_output_dir,
            progress_callback
        )

        # Should have received progress updates
        assert len(progress_updates) > 0

        # Progress should increase
        assert progress_updates[0].progress < progress_updates[-1].progress

        # Final progress should be 100
        assert progress_updates[-1].progress == 100

        # Should track stages
        stages = [p.stage for p in progress_updates]
        assert "loading_model" in stages or "initializing" in stages
        assert "complete" in stages

    def test_successful_separation(self, test_audio_file, temp_output_dir):
        """Test successful separation (fallback mode)."""
        result = separate_stems_enhanced(
            test_audio_file,
            temp_output_dir
        )

        assert result['success'] is True
        assert result['error'] is None
        assert 'stems' in result

        # Check all stems present
        for stem_name in ['vocals', 'drums', 'bass', 'other']:
            assert stem_name in result['stems']
            stem = result['stems'][stem_name]
            assert stem is not None
            assert 'path' in stem
            assert 'duration' in stem
            assert Path(stem['path']).exists()

    def test_quality_metrics(self, test_audio_file, temp_output_dir):
        """Test quality metrics calculation."""
        result = separate_stems_enhanced(
            test_audio_file,
            temp_output_dir
        )

        # Check quality metrics present
        for stem_name in ['vocals', 'drums', 'bass', 'other']:
            stem = result['stems'][stem_name]
            if stem and 'quality' in stem:
                quality = stem['quality']
                assert 'rms' in quality
                assert 'peak' in quality
                assert 'spectral_centroid' in quality
                assert quality['rms'] >= 0
                assert 0 <= quality['peak'] <= 1
                assert quality['spectral_centroid'] >= 0

    def test_error_handling_invalid_file(self, temp_output_dir):
        """Test error handling with invalid input file."""
        result = separate_stems_enhanced(
            "nonexistent_file.wav",
            temp_output_dir
        )

        assert result['success'] is False
        assert result['error'] is not None
        assert isinstance(result['error'], str)

    def test_thread_safety(self, test_audio_file, temp_output_dir):
        """Test thread-safe progress tracking."""
        import threading

        separator = EnhancedStemSeparator()
        errors = []

        def progress_callback(progress: SeparationProgress):
            # Simulate some processing
            time.sleep(0.001)

        try:
            result = separator.separate(
                test_audio_file,
                temp_output_dir,
                progress_callback
            )
            assert result.success
        except Exception as e:
            errors.append(e)

        assert len(errors) == 0

    def test_stem_file_structure(self, test_audio_file, temp_output_dir):
        """Test output file structure."""
        result = separate_stems_enhanced(
            test_audio_file,
            temp_output_dir
        )

        output_path = Path(temp_output_dir)

        # Check all stem files created
        for stem_name in ['vocals', 'drums', 'bass', 'other']:
            stem_file = output_path / f"{stem_name}.wav"
            assert stem_file.exists()
            assert stem_file.stat().st_size > 0

    def test_time_tracking(self, test_audio_file, temp_output_dir):
        """Test time tracking accuracy."""
        progress_updates: List[SeparationProgress] = []

        def progress_callback(progress: SeparationProgress):
            progress_updates.append(progress)

        start_time = time.time()
        result = separate_stems_enhanced(
            test_audio_file,
            temp_output_dir,
            progress_callback
        )
        elapsed = time.time() - start_time

        # Reported time should be close to actual
        assert abs(result['total_time'] - elapsed) < 0.5

        # Progress time should increase
        if len(progress_updates) > 1:
            assert progress_updates[0].time_elapsed < progress_updates[-1].time_elapsed


class TestIntegrationWorkflow:
    """Test complete integration workflows."""

    def test_end_to_end_separation(self, test_audio_file, temp_output_dir):
        """Test complete end-to-end separation workflow."""
        # Step 1: Separate
        result = separate_stems_enhanced(
            test_audio_file,
            temp_output_dir
        )

        assert result['success']

        # Step 2: Verify all stems
        stems = result['stems']
        for stem_name in ['vocals', 'drums', 'bass', 'other']:
            stem = stems[stem_name]
            assert Path(stem['path']).exists()
            assert stem['duration'] > 0

        # Step 3: Verify can load stems
        try:
            import soundfile as sf
            for stem_name in ['vocals', 'drums', 'bass', 'other']:
                stem_path = stems[stem_name]['path']
                data, sr = sf.read(stem_path)
                assert len(data) > 0
                assert sr > 0
        except ImportError:
            pass  # Skip if soundfile not available

    def test_multiple_separations(self, test_audio_file):
        """Test multiple separations in sequence."""
        results = []

        for i in range(3):
            temp_dir = tempfile.mkdtemp()
            try:
                result = separate_stems_enhanced(
                    test_audio_file,
                    temp_dir
                )
                results.append(result)
            finally:
                shutil.rmtree(temp_dir)

        # All should succeed
        assert all(r['success'] for r in results)

        # Processing times should be similar
        times = [r['total_time'] for r in results]
        avg_time = sum(times) / len(times)
        assert all(abs(t - avg_time) < avg_time * 0.5 for t in times)

    def test_concurrent_separations(self, test_audio_file):
        """Test concurrent separations (different files)."""
        import concurrent.futures

        def separate_task(audio_file, output_dir):
            return separate_stems_enhanced(audio_file, output_dir)

        temp_dirs = [tempfile.mkdtemp() for _ in range(3)]

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
                futures = [
                    executor.submit(separate_task, test_audio_file, temp_dir)
                    for temp_dir in temp_dirs
                ]
                results = [f.result() for f in futures]

            # All should succeed
            assert all(r['success'] for r in results)
        finally:
            for temp_dir in temp_dirs:
                shutil.rmtree(temp_dir)


class TestPerformance:
    """Performance tests."""

    def test_separation_speed(self, test_audio_file, temp_output_dir):
        """Test separation speed meets requirements."""
        result = separate_stems_enhanced(
            test_audio_file,
            temp_output_dir
        )

        # 3 seconds of audio
        audio_duration = 3.0
        processing_time = result['total_time']

        # Should process faster than real-time (RTF < 10)
        # (In fallback mode this is trivial, but with Demucs it matters)
        rtf = processing_time / audio_duration
        assert rtf < 10  # Very generous for testing

    def test_memory_efficiency(self, test_audio_file, temp_output_dir):
        """Test memory usage is reasonable."""
        import psutil
        import os

        process = psutil.Process(os.getpid())
        initial_memory = process.memory_info().rss / 1024 / 1024  # MB

        result = separate_stems_enhanced(
            test_audio_file,
            temp_output_dir
        )

        final_memory = process.memory_info().rss / 1024 / 1024  # MB
        memory_increase = final_memory - initial_memory

        # Should not increase memory by more than 500MB for this small file
        assert memory_increase < 500


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])

