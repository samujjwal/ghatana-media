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

test("native media ending stops at the authored scene boundary without selecting a branch", () => {
  const initial = createDemoPlayerState(manifest, verifier);
  const playing = reduceDemoPlayerState(manifest, initial, { type: "play" }, verifier);
  const advanced = reduceDemoPlayerState(manifest, playing, { type: "progress", positionMs: 500 }, verifier);
  const ended = reduceDemoPlayerState(manifest, advanced, { type: "ended" }, verifier);

  assert.equal(ended.positionMs, 1_000);
  assert.equal(ended.playing, false);
  assert.equal(ended.activeSceneId, "intro");
  assert.deepEqual(ended.route, ["intro"]);
  assert.deepEqual(ended.branches, []);
});

test("media failure is typed and does not expose provider or browser error details", () => {
  const initial = createDemoPlayerState(manifest, verifier);
  const playing = reduceDemoPlayerState(manifest, initial, { type: "play" }, verifier);
  const failed = reduceDemoPlayerState(manifest, playing, { type: "playback-failed" }, verifier);

  assert.equal(failed.status, "UNAVAILABLE");
  assert.equal(failed.failure, "MEDIA_PLAYBACK_FAILED");
  assert.equal(failed.playing, false);
  assert.equal(failed.announcement, "Interactive demonstration unavailable: media playback failed.");
  assert.equal(failed.announcement.includes("DOMException"), false);
});

test("manifest rejects duplicate branch IDs that make a local choice ambiguous", () => {
  const ambiguous = {
    ...manifest,
    scenes: manifest.scenes.map((scene) => scene.id === "intro"
      ? {
          ...scene,
          branches: [
            scene.branches[0],
            { id: "next", label: "Alternate label", targetSceneId: "intro" },
          ],
        }
      : scene),
  };
  const state = createDemoPlayerState(ambiguous, {
    attest: () => ({
      manifestId: ambiguous.id,
      revision: ambiguous.revision,
      sha256: ambiguous.integrity.sha256,
      actualEmbeddingOrigin: hostOrigin,
      sourceTruth: ambiguous.sourceTruth,
      originPermissions: ambiguous.originPermissions,
    }),
  });

  assert.equal(state.status, "UNAVAILABLE");
  assert.equal(state.failure, "INVALID_BUNDLE");
  assert.equal(state.route.length, 0);
});

test("manifest rejects duplicate caption cue IDs within a scene before playback", () => {
  const ambiguous = {
    ...manifest,
    scenes: manifest.scenes.map((scene) => scene.id === "intro"
      ? {
          ...scene,
          captions: {
            ...scene.captions,
            cues: [
              { id: "caption-1", startMs: 0, endMs: 400, text: "First cue." },
              { id: "caption-1", startMs: 400, endMs: 800, text: "Second cue." },
            ],
          },
        }
      : scene),
  };
  const state = createDemoPlayerState(ambiguous, {
    attest: () => ({
      manifestId: ambiguous.id,
      revision: ambiguous.revision,
      sha256: ambiguous.integrity.sha256,
      actualEmbeddingOrigin: hostOrigin,
      sourceTruth: ambiguous.sourceTruth,
      originPermissions: ambiguous.originPermissions,
    }),
  });

  assert.equal(state.status, "UNAVAILABLE");
  assert.equal(state.failure, "INVALID_BUNDLE");
  assert.equal(state.route.length, 0);
  assert.equal(state.playing, false);
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
