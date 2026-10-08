# R-03 runtime hardening observations

**Observation date:** 2026-10-08
**Scope:** source changes and focused tests in this Media checkout only. This is not production durability, security, or operations qualification.

## Media-owned local fix

`modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/video/VideoFrameExtractor.java` previously read FFmpeg/FFprobe output to EOF before applying its timeout. A child that held the pipe open could prevent the timeout check from running; noisy output was accumulated without a bound and extraction failures logged the raw child text. The helper now drains the merged child output concurrently, captures at most 16,384 diagnostic characters, applies the timeout while the drain is active, terminates timed-out children, and reports only the exit status and captured length. The metadata path rejects nonzero FFprobe results rather than parsing partial failure output, and the FFmpeg availability probe uses the same bounded runner. Timestamp arguments use locale-independent decimal formatting.

The per-frame extraction path now resolves the input with `toRealPath`, normalizes its output path, and rejects negative timestamps. Extraction configuration bounds frame rate to 1–60, frame count to 1–10,000, dimensions to 1–8,192 pixels (or the `-1/-1` source-size sentinel), and quality to 1–31. These are local resource bounds, not a codec support policy or deployment profile.

Focused test `VideoFrameExtractorProcessTest` exercises oversized child output, a timeout while the child keeps its output pipe open, and invalid extraction bounds. Passing this test establishes only those source-level behaviors.

## Qualification still required

- Run the decoder in a production sandbox with CPU, memory, disk, process-count, and network restrictions; the Java timeout alone does not provide OS-level containment.
- Verify child-process descendant termination and temporary-output cleanup on the supported deployment OS/runtime matrix.
- Pin exact FFmpeg/FFprobe binaries and enabled codecs, deployed image and transitive SBOM; obtain distribution-license and patent review for each profile.
- Run hostile-input parser/fuzzing, representative correctness fixtures, target-hardware performance and soak/failure-injection suites.
- Obtain independent security, codec/runtime, release-operations, and licensing reviews where applicable.

No codec/container profile, model, production deployment, Lifecycle proof, release authorization, or R-03 qualification is claimed by this observation.
