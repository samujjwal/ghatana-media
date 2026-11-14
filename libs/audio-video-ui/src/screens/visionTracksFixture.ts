// Test fixture: a small, complete tracks document (not a product asset).
/** A small but complete document: 640x360 video, time base 1/10240, three sampled frames, two tracks. */
export function sampleDocument(): Record<string, unknown> {
  const frame = (frameIndex: number, pts: number) => ({ frameIndex, pts, ptsMicros: Math.floor(pts * 1_000_000 / 10240), detections: 2, rejectedDetections: 0 });
  const observation = (frameIndex: number, pts: number, x: number, y: number, width: number, height: number) =>
    ({ frameIndex, pts, ptsMicros: Math.floor(pts * 1_000_000 / 10240), box: { x, y, width, height } });
  return {
    schema: "media.dev.vision-tracks.v1", scope: "DEV_ONLY", kind: "LOCAL_VISION_TRACKS", requestId: "req-1",
    source: { artifactId: "src-1", artifactVersionId: `sha256:${"a".repeat(64)}`, sha256: "a".repeat(64), contentType: "video/mp4" },
    video: { width: 640, height: 360, timeBase: { num: 1, den: 10240 }, frameCount: 30, variableFrameRate: false },
    tracking: { algorithm: "GREEDY_IOU_LABEL_V1", minIou: 0.3, maxMissedFrames: 1 },
    model: { id: "florence-community/Florence-2-large", revision: "r1", spdxLicense: "MIT" },
    frames: [frame(0, 0), frame(3, 3072), frame(6, 6144)],
    tracks: [
      { trackId: "T0001", label: "car", firstFrameIndex: 0, lastFrameIndex: 6, observationCount: 3, observations: [
        observation(0, 0, 20, 250, 160, 77), observation(3, 3072, 47, 250, 160, 77), observation(6, 6144, 74, 250, 160, 77)] },
      { trackId: "T0002", label: "person", firstFrameIndex: 3, lastFrameIndex: 6, observationCount: 2, observations: [
        observation(3, 3072, 500, 55, 68, 151), observation(6, 6144, 500, 70, 68, 151)] },
    ],
  };
}
