/**
 * Audio-Video Processing Library for Java
 *
 * <p>Provides embeddable speech-to-text, text-to-speech, and computer vision
 * capabilities for Java applications.
 *
 * <p>Quick Start:
 * <pre>{@code
 * // Create library
 * AudioVideoLibrary library = AudioVideoLibrary.builder()
 *     .withSttConfig(SttConfig.builder()
 *         .modelPath(Paths.get("/models/whisper.onnx"))
 *         .build())
 *     .build();
 *
 * // Use STT
 * try (SttEngine stt = library.getSttEngine()) {
 *     TranscriptionResult result = stt.transcribe(audioData);
 * }
 * }</pre>
 *
 * @since 0.0.1
 */
package com.ghatana.media;
