import assert from "node:assert/strict";
import test from "node:test";
import {
  createDemoPlayerState,
  demoCaptionAt,
  replayDemoBranchPath,
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

  const playAtEnd = reduceDemoPlayerState(manifest, ended, { type: "play" }, verifier);
  assert.equal(playAtEnd, ended);
  assert.equal(playAtEnd.playing, false);
  assert.equal(playAtEnd.announcement, "Finished Introduction. Choose a path or replay.");
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

test("manifest accepts only safe integer milliseconds for scenes and caption cues", () => {
  const invalidManifests = [
    {
      ...manifest,
      scenes: manifest.scenes.map((scene) => scene.id === "intro"
        ? { ...scene, startMs: 0.5 }
        : scene),
    },
    {
      ...manifest,
      scenes: manifest.scenes.map((scene) => scene.id === "intro"
        ? { ...scene, endMs: Number.MAX_SAFE_INTEGER + 1 }
        : scene),
    },
    {
      ...manifest,
      scenes: manifest.scenes.map((scene) => scene.id === "intro"
        ? {
            ...scene,
            captions: {
              ...scene.captions,
              cues: [{ id: "cue", startMs: 0.5, endMs: 100, text: "Fractional cue." }],
            },
          }
        : scene),
    },
    {
      ...manifest,
      scenes: manifest.scenes.map((scene) => scene.id === "intro"
        ? {
            ...scene,
            captions: {
              ...scene.captions,
              cues: [{ id: "cue", startMs: 0, endMs: Number.MAX_SAFE_INTEGER + 1, text: "Unsafe cue." }],
            },
          }
        : scene),
    },
  ];

  for (const candidate of invalidManifests) {
    const state = createDemoPlayerState(candidate, {
      attest: () => ({
        manifestId: candidate.id,
        revision: candidate.revision,
        sha256: candidate.integrity.sha256,
        actualEmbeddingOrigin: hostOrigin,
        sourceTruth: candidate.sourceTruth,
        originPermissions: candidate.originPermissions,
      }),
    });
    assert.equal(state.status, "UNAVAILABLE");
    assert.equal(state.failure, "INVALID_BUNDLE");
    assert.equal(state.route.length, 0);
  }
});

test("seek and progress reject unsafe millisecond positions without changing state", () => {
  const initial = createDemoPlayerState(manifest, verifier);
  const seeked = reduceDemoPlayerState(manifest, initial, { type: "seek", positionMs: 500 }, verifier);
  assert.equal(seeked.positionMs, 500);
  assert.equal(seeked.playing, false);

  for (const positionMs of [500.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    assert.equal(
      reduceDemoPlayerState(manifest, seeked, { type: "seek", positionMs }, verifier),
      seeked,
    );
  }

  const playing = reduceDemoPlayerState(manifest, seeked, { type: "play" }, verifier);
  assert.equal(
    reduceDemoPlayerState(manifest, playing, {
      type: "progress",
      positionMs: Number.MAX_SAFE_INTEGER + 1,
    }, verifier),
    playing,
  );
});

test("caption selection uses the same safe integer millisecond clock as playback", () => {
  const scene = {
    ...manifest.scenes[0],
    captions: {
      ...manifest.scenes[0].captions,
      cues: [{ id: "cue", startMs: 100, endMs: 200, text: "Exact interval." }],
    },
  };

  assert.equal(demoCaptionAt(scene, 100), "Exact interval.");
  assert.equal(demoCaptionAt(scene, 199), "Exact interval.");
  assert.equal(demoCaptionAt(scene, 200), "");
  assert.equal(demoCaptionAt(scene, 100.5), "");
  assert.equal(demoCaptionAt(scene, Number.MAX_SAFE_INTEGER + 1), "");
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

test("manifest rejects a keyboard branch in a scene unreachable from the initial scene", () => {
  const disconnected = {
    ...manifest,
    scenes: [
      ...manifest.scenes,
      {
        id: "island",
        label: "Unreachable scene",
        startMs: 2_000,
        endMs: 3_000,
        asset: { url: "/island.mp4", version: "v1", sourceRevision: "s1" },
        captions: { language: "en", assetVersion: "v1", cues: [] },
        branches: [{ id: "hidden-choice", label: "Hidden choice", targetSceneId: "next" }],
      },
    ],
  };
  const state = createDemoPlayerState(disconnected, {
    attest: () => ({
      manifestId: disconnected.id,
      revision: disconnected.revision,
      sha256: disconnected.integrity.sha256,
      actualEmbeddingOrigin: hostOrigin,
      sourceTruth: disconnected.sourceTruth,
      originPermissions: disconnected.originPermissions,
    }),
  });

  assert.equal(state.status, "UNAVAILABLE");
  assert.equal(state.failure, "INVALID_BUNDLE");
  assert.deepEqual(state.route, []);
});

test("manifest rejects ambiguous or sparse origin permission entries", () => {
  const malformedPermissions = [
    [
      { origin: "https://cdn.example.test", capabilities: ["read-asset"] },
      { origin: "https://cdn.example.test", capabilities: ["read-caption"] },
    ],
    [{ origin: "https://cdn.example.test", capabilities: ["read-asset", "read-asset"] }],
    Array(1),
    [{ origin: "https://cdn.example.test", capabilities: Array(1) }],
  ];

  for (const originPermissions of malformedPermissions) {
    const candidate = { ...manifest, originPermissions };
    const state = createDemoPlayerState(candidate, {
      attest: () => ({
        manifestId: candidate.id,
        revision: candidate.revision,
        sha256: candidate.integrity.sha256,
        actualEmbeddingOrigin: hostOrigin,
        sourceTruth: candidate.sourceTruth,
        originPermissions,
      }),
    });

    assert.equal(state.status, "UNAVAILABLE");
    assert.equal(state.failure, "INVALID_BUNDLE");
    assert.equal(state.route.length, 0);
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

test("replay rejects action streams above the recorded-action bound before processing a prefix", () => {
  const actions = Array.from({ length: 10_001 }, () => ({ type: "play" }));
  const replayed = replayDemoActions(manifest, verifier, actions);

  assert.equal(replayed.status, "UNAVAILABLE");
  assert.equal(replayed.failure, "PLAYBACK_LIMIT_REACHED");
  assert.equal(replayed.playing, false);
  assert.deepEqual(replayed.history, []);
});

test("branch-path replay enforces the route bound before copying caller input", () => {
  const loopManifest = {
    ...manifest,
    scenes: manifest.scenes.map((scene) => scene.id === "intro"
      ? {
          ...scene,
          branches: [
            { id: "loop", label: "Repeat", targetSceneId: "intro" },
            { id: "next", label: "Continue", targetSceneId: "next" },
          ],
        }
      : scene),
  };
  const loopVerifier = {
    attest: () => ({
      manifestId: loopManifest.id,
      revision: loopManifest.revision,
      sha256: loopManifest.integrity.sha256,
      actualEmbeddingOrigin: hostOrigin,
      sourceTruth: loopManifest.sourceTruth,
      originPermissions: loopManifest.originPermissions,
    }),
  };
  const allowedPath = Array.from({ length: 255 }, () => ({
    fromSceneId: "intro",
    choiceId: "loop",
    toSceneId: "intro",
  }));
  const allowed = replayDemoBranchPath(loopManifest, loopVerifier, allowedPath);
  assert.equal(allowed.status, "READY");
  assert.equal(allowed.route.length, 256);
  assert.equal(allowed.branches.length, 255);

  const oversizedPath = [...allowedPath, {
    fromSceneId: "intro",
    choiceId: "loop",
    toSceneId: "intro",
  }];
  Object.defineProperty(oversizedPath, "map", {
    value: () => { throw new Error("oversized path must be rejected before mapping"); },
  });
  const rejected = replayDemoBranchPath(loopManifest, loopVerifier, oversizedPath);
  assert.equal(rejected.status, "UNAVAILABLE");
  assert.equal(rejected.failure, "PLAYBACK_LIMIT_REACHED");
  assert.deepEqual(rejected.history, []);
  assert.deepEqual(rejected.route, ["intro"]);
});

test("branch-path replay rejects sparse or forged authored edges before returning a route", () => {
  const forgedVisits = [
    [{ fromSceneId: "other", choiceId: "next", toSceneId: "next" }],
    [{ fromSceneId: "intro", choiceId: "next", toSceneId: "intro" }],
    Array(1),
  ];

  for (const visits of forgedVisits) {
    const replayed = replayDemoBranchPath(manifest, verifier, visits);
    assert.equal(replayed.status, "UNAVAILABLE");
    assert.equal(replayed.failure, "INVALID_BUNDLE");
    assert.deepEqual(replayed.route, ["intro"]);
    assert.deepEqual(replayed.branches, []);
    assert.deepEqual(replayed.history, []);
  }
});
