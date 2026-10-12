import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const paths = {
  valueObjects: ".product-experience/pdp-1-domain-data/value-objects.yaml",
  p0: ".product-experience/pdp-0-product-truth/time-units-fidelity.yaml",
  interop: ".product-experience/pdp-1-domain-data/interoperability.yaml",
  versioning: ".product-experience/pdp-1-domain-data/versioning.yaml",
  provenance: ".product-experience/pdp-1-domain-data/provenance.yaml",
  editing: ".product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml",
  animation: ".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml",
  legacyTs: "libs/audio-video-types/src/index.ts",
  contractTs: "libs/audio-video-types/src/contracts.ts",
  java: "runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java",
  openapi: "contracts/openapi/media.yaml",
  sttProto: "modules/speech/stt-service/src/main/proto/stt_service.proto",
  ttsProto: "modules/speech/tts-service/src/main/proto/tts_service.proto",
  visionProto: "modules/vision/vision-service/src/main/proto/vision_service.proto",
  multimodalProto: "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
};
const read = (path) => readFileSync(path, "utf8");

function validate(files) {
  const errors = [];
  const requireText = (file, marker, label = marker) => {
    if (!files[file].includes(marker)) errors.push(`${file} missing source-backed field or disposition: ${label}`);
  };

  const observations = files.valueObjects.slice(files.valueObjects.indexOf("observedTemporalSpatialFields:"));
  for (const marker of [
    "AudioData.durationMs", "AudioData.sampleRate", "VideoData.durationMs", "VideoData.fps",
    "WordTimestamp.start, WordTimestamp.end", "numeric-values-without-declared-unit",
    "BoundingBox.x, BoundingBox.y, BoundingBox.width, BoundingBox.height",
    "TranscriptionResult.words[].startMs", "SynthesisResult.durationMs", "ProviderCapability.maxDurationMs",
    "StreamSession.leaseExpiresAt", "StreamFrame.receivedAt", "StreamSessionRequest.leaseDuration",
    "StreamFrame.sequence", "StreamAck.acceptedSequence", "POST /api/v1/streams/{sessionId}/frames/{sequence}",
    "WordTiming.start_ms", "SynthesizeResponse.duration_ms", "VideoFileRequest.sample_fps",
    "VideoAudioRequest.frame_sample_rate", "CrossModalEvent.timestamp_ms",
    "media durations and positions are distinct from Java/OpenAPI wall-clock Instants",
    "frame_number and stream sequence are integer identities/counters, not timestamps",
    "legacy VideoData.fps, Vision VideoFileRequest.sample_fps, and Multimodal VideoAudioRequest.frame_sample_rate remain separate",
    "Vision and Multimodal BoundingBox numeric x/y/width/height fields do not establish equal coordinate spaces",
    "rational-timebase: unresolved", "coordinate-system: unresolved", "profiles-and-conversion: unresolved",
    "external-owner-acceptance: not-established",
  ]) if (!observations.includes(marker)) errors.push(`PDP1 value-object observation missing ${marker}`);
  for (const marker of [
    "scalar-fps-and-unqualified-time-coordinates; enum-vocabulary-may-drift",
    "timestamp_ms-is-not-source-PTS-or-sample-exact-mapping",
    "no-canonical-artifact-version-record-or-key-observed",
    "canonical-derived-version-identity-and-ancestry-unbound",
  ]) if (!files.interop.includes(marker) && !files.versioning.includes(marker)) errors.push(`PDP1 interoperability/versioning reconciliation missing ${marker}`);
  for (const marker of [
    "requiredWhenConversionOccurs: [sourceClockOrUnit, destinationClockOrUnit, origin, roundingOrIntervalPolicy, measuredLossOrUnknown]",
    "scopeStatus: PDP-0-time-fidelity-proposal; pending-owner-review",
    "sourceClockOrUnit, destinationClockOrUnit, origin, roundingOrIntervalPolicy, measuredLossOrUnknown",
  ]) if (!files.provenance.includes(marker) && !observations.includes(marker)) errors.push(`PDP1 provenance conversion boundary missing ${marker}`);

  requireText("legacyTs", "export interface WordTimestamp {\n  word: string;\n  start: number;\n  end: number;");
  requireText("legacyTs", "export interface VideoData {\n  data: ArrayBuffer;\n  width: number;\n  height: number;\n  durationMs: number;\n  fps: number;");
  requireText("contractTs", "startMs: NonNegativeIntegerSchema");
  requireText("contractTs", "endMs: NonNegativeIntegerSchema");
  requireText("contractTs", "durationMs: NonNegativeIntegerSchema");
  requireText("contractTs", "const ConfidenceSchema = z.number().min(0).max(1);");
  requireText("contractTs", "confidence: ConfidenceSchema");
  requireText("java", "Duration leaseDuration");
  requireText("java", "if (leaseDuration == null || leaseDuration.isZero() || leaseDuration.isNegative()");
  requireText("java", "long sequence,");
  requireText("java", "if (sequence < 0) throw new IllegalArgumentException(\"sequence must not be negative\")");
  requireText("openapi", "name: sequence,\n            in: path,\n            required: true,\n            schema: { type: integer, format: int64, minimum: 0 }");
  requireText("openapi", "leaseDuration: { type: string, format: duration }");
  requireText("openapi", "timestamp:\n          type: string\n          format: date-time");

  for (const [file, markers] of Object.entries({
    sttProto: ["int64 timestamp_ms = 3;", "int64 start_ms = 2;", "int64 end_ms = 3;", "int32 sample_rate = 2;"],
    ttsProto: ["int64 duration_ms = 3;", "int64 timestamp_ms = 3;", "int32 sample_rate = 2;"],
    visionProto: ["int64 timestamp_ms = 2;", "int32 frame_number = 3;", "int32 sample_fps = 2;", "int64 video_duration_ms = 4;", "double x = 1;", "double width = 3;"],
    multimodalProto: ["int32 frame_sample_rate = 4;", "int64 timestamp_ms = 1;", "int64 analysis_window_ms = 3;", "double x = 1;", "double width = 3;"],
  })) for (const marker of markers) requireText(file, marker);
  for (const [file, markers] of Object.entries({
    sttProto: ["message Transcription {", "float confidence = 3;", "float confidence_threshold = 5;"],
    visionProto: ["message Detection {", "message ClassLabel {", "double confidence_threshold = 4;"],
    multimodalProto: ["message AudioAnalysis {", "message VisualAnalysis {", "double alignment_score = 1;", "map<string, double> confidence_scores = 5;"],
  })) for (const marker of markers) requireText(file, marker);

  for (const marker of [
    "rationalTime:", "rationalRate:", "status: proposed-and-unverified",
    "handedness: right-handed", "upAxis: +Y", "cameraForward: -Z",
    "status: Proposed initial Media convention from master-plan section 8.3; not verified against an admitted Media scene/model contract.",
    "acceptance: not-submitted", "implementation: no-conversions-are-qualified-by-this-file",
  ]) if (!files.p0.includes(marker)) errors.push(`PDP0 proposal boundary missing ${marker}`);
  for (const marker of [
    "status: authored-proposal; P0-010-and-audio-specialist-review-pending",
    "Source playback time is mapped to the source presentation clock; wall-clock time is never used as media position.",
    "Timing displays disclose rounding and frame/sample conversion when the exact source time cannot be shown.",
  ]) if (!files.editing.includes(marker)) errors.push(`editing grammar boundary missing ${marker}`);
  for (const marker of [
    "status: authored-proposal; graphics-simulation-and-domain-owner-review-pending",
    "Keep animation/story time, media presentation time, simulation time, and wall-clock deadlines visibly distinct.",
    "Scrubbing or pausing a presentation never silently advances or changes the simulation model.",
  ]) if (!files.animation.includes(marker)) errors.push(`animation grammar boundary missing ${marker}`);
  if (!files.valueObjects.includes("scopeStatus: proposed-values-and-observed-fields; pending-owner-review")) errors.push("PDP1 value-object owner review must remain pending");
  if (!files.interop.includes("semantic-and-consumer-parity-review-pending")) errors.push("interoperability semantics and consumer parity must remain pending");
  for (const marker of [
    "spatialTransformDeclarationContract:", "frameVersionRef", "handedness", "axisDirections",
    "positionUnitRef", "orientationUnitRef", "orderedOperations", "mappingRef",
    "result: DECLARED_NOT_APPLIED", "unknown, stale or mismatched descriptors",
    "providerSignalContract:", "metricVersionRef", "methodVersionRef", "unitRef",
    "crossProvider: NOT_COMPARABLE", "crossMetric: NOT_COMPARABLE",
    "calibration, correctness, probability, ranking equivalence or scientific validity",
  ]) if (!files.valueObjects.includes(marker)) errors.push(`P1-09 typed value contract missing ${marker}`);
  for (const marker of [
    "observedSpatialAndProviderSignalFields:", "media.observed-provider-signal.protobuf-stt",
    "media.observed-provider-signal.protobuf-vision", "media.observed-provider-signal.protobuf-multimodal",
    "Transcription.confidence", "Detection.confidence", "CrossModalResponse.alignment_score",
    "no-versioned-adapter-or-calibration-binding-accepted", "confidence_threshold is an input policy threshold",
    "WordTimestamp.confidence", "ClassLabel.confidence", "FaceDetection.confidence",
    "TranscriptionOptions.confidence_threshold", "InsightsResponse.confidence_scores",
  ]) if (!files.interop.includes(marker)) errors.push(`P1-09 source-specific signal boundary missing ${marker}`);
  if (!files.versioning.includes("scopeStatus: proposed-boundaries-with-observed-compatibility; pending-owner-review")) errors.push("versioning owner review must remain pending");
  if (!files.provenance.includes("scopeStatus: owner-defined-conditional-lineage-semantics; event-and-runtime-observations-remain-explicitly-unknown")) errors.push("conditional lineage semantics must be owner-defined without claiming event/runtime observations");
  if (!files.provenance.includes("scopeStatus: PDP-0-time-fidelity-proposal; pending-owner-review")) errors.push("time conversion policy must retain its separate PDP-0 owner-review boundary");
  return errors;
}

const base = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, read(path)]));

test("temporal and spatial inventory preserves exact source fields and separates incompatible dimensions", () => {
  assert.deepEqual(validate(base), []);
});

test("temporal and spatial regression rejects unit inference, source drift, or canonical promotion", () => {
  const inferredWordUnit = base.valueObjects.replace("numeric-values-without-declared-unit", "milliseconds");
  assert.match(validate({ ...base, valueObjects: inferredWordUnit }).join("\n"), /numeric-values-without-declared-unit/u);
  const staleVisionSource = base.visionProto.replaceAll("int64 timestamp_ms = 2;", "int64 timestamp = 2;");
  assert.match(validate({ ...base, visionProto: staleVisionSource }).join("\n"), /visionProto missing source-backed field or disposition: int64 timestamp_ms = 2/u);
  const promotedTimebase = base.valueObjects.replace("rational-timebase: unresolved", "rational-timebase: accepted-24-fps");
  assert.match(validate({ ...base, valueObjects: promotedTimebase }).join("\n"), /rational-timebase: unresolved/u);
  const promotedCoordinates = base.valueObjects.replace("coordinate-system: unresolved", "coordinate-system: right-handed-y-up");
  assert.match(validate({ ...base, valueObjects: promotedCoordinates }).join("\n"), /coordinate-system: unresolved/u);
  const promotedP0 = base.p0.replace("acceptance: not-submitted", "acceptance: accepted");
  assert.match(validate({ ...base, p0: promotedP0 }).join("\n"), /PDP0 proposal boundary missing/u);
});
