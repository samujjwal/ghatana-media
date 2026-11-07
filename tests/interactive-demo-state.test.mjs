import assert from "node:assert/strict";
import test from "node:test";
import {
  createDemoPlayerState,
  replayDemoActions,
  reduceDemoPlayerState,
} from "../libs/audio-video-ui/src/player/interactiveDemoState.ts";

const hostOrigin = "https://media.example.test";
const manifest = {
  id: "demo",
  revision: "r1",
  sourceRevision: "s1",
  hostOrigin,
  integrity: { status: "verified", sha256: "a".repeat(64), verificationRef: "verified:r1" },
  sourceTruth: { kind: "simulation" },
  originPermissions: [],
  initialSceneId: "intro",
  scenes: [{
    id: "intro",
    label: "Introduction",
    startMs: 0,
    endMs: 1_000,
    asset: { url: "/intro.mp4", version: "v1", sourceRevision: "s1" },
    captions: { language: "en", assetVersion: "v1", cues: [] },
    branches: [{ id: "next", label: "Continue", targetSceneId: "next" }],
  }, {
    id: "next",
    label: "Next",
    startMs: 1_000,
    endMs: 2_000,
    asset: { url: "/next.mp4", version: "v1", sourceRevision: "s1" },
    captions: { language: "en", assetVersion: "v1", cues: [] },
    branches: [],
  }],
};
const verifier = {
  attest: () => ({
    manifestId: manifest.id,
    revision: manifest.revision,
    sha256: manifest.integrity.sha256,
    actualEmbeddingOrigin: hostOrigin,
    sourceTruth: manifest.sourceTruth,
    originPermissions: manifest.originPermissions,
  }),
};

test("progress advances playing state and pauses at scene end without branching", () => {
  const initial = createDemoPlayerState(manifest, verifier);
  const playing = reduceDemoPlayerState(manifest, initial, { type: "play" }, verifier);
  const advanced = reduceDemoPlayerState(manifest, playing, { type: "progress", positionMs: 500 }, verifier);
  assert.equal(advanced.positionMs, 500);
  assert.equal(advanced.playing, true);

  const ended = reduceDemoPlayerState(manifest, advanced, { type: "progress", positionMs: 1_000 }, verifier);
  assert.equal(ended.positionMs, 1_000);
  assert.equal(ended.playing, false);
  assert.equal(ended.activeSceneId, "intro");
  assert.deepEqual(ended.route, ["intro"]);
  assert.deepEqual(ended.branches, []);
});

test("progress rejects paused, fractional, backward, and out-of-scene positions", () => {
  const initial = createDemoPlayerState(manifest, verifier);
  assert.equal(
    reduceDemoPlayerState(manifest, initial, { type: "progress", positionMs: 100 }, verifier),
    initial,
  );
  const playing = reduceDemoPlayerState(manifest, initial, { type: "play" }, verifier);
  const advanced = reduceDemoPlayerState(manifest, playing, { type: "progress", positionMs: 500 }, verifier);
  for (const positionMs of [499, 500.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      reduceDemoPlayerState(manifest, advanced, { type: "progress", positionMs }, verifier),
      advanced,
    );
  }
});

test("replay reproduces play and progress state, status, and history", () => {
  const actions = [
    { type: "play" },
    { type: "progress", positionMs: 500 },
  ];
  const replayed = replayDemoActions(manifest, verifier, actions);
  const stepped = actions.reduce(
    (state, action) => reduceDemoPlayerState(manifest, state, action, verifier),
    createDemoPlayerState(manifest, verifier),
  );

  assert.deepEqual(replayed, stepped);
  assert.equal(replayed.positionMs, 500);
  assert.equal(replayed.status, "READY");
  assert.deepEqual(replayed.history, actions);
});
