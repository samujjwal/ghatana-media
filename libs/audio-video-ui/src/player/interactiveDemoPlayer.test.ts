import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createDemoPlayerState,
  demoCaptionAt,
  demoSourceTruthLabel,
  InteractiveDemoPlayer,
  replayDemoBranchPath,
  reduceDemoPlayerState,
  replayDemoActions,
  type DemoPlayerAction,
  type DemoHostVerificationPort,
  type InteractiveDemoManifest,
} from "./interactiveDemoPlayer";

const HOST = "https://media.example.test";
const BASE_DIGEST = "a".repeat(64);
const BASE: InteractiveDemoManifest = {
  id: "demo-1",
  revision: "demo-rev-4",
  sourceRevision: "project-rev-12",
  hostOrigin: HOST,
  integrity: {
    status: "verified",
    sha256: BASE_DIGEST,
    verificationRef: "bundle-verifier:demo-rev-4",
  },
  sourceTruth: { kind: "simulation" },
  originPermissions: [],
  initialSceneId: "intro",
  scenes: [
    {
      id: "intro",
      label: "Introduction",
      startMs: 0,
      endMs: 1_000,
      asset: { url: "/assets/intro.mp4", version: "asset-intro-v3", sourceRevision: "project-rev-12" },
      captions: {
        language: "en",
        assetVersion: "asset-intro-v3",
        cues: [{ id: "intro-caption", startMs: 0, endMs: 600, text: "Choose a path." }],
      },
      branches: [
        { id: "left", label: "Explore left path", targetSceneId: "left-scene" },
        { id: "right", label: "Explore right path", targetSceneId: "right-scene" },
      ],
    },
    {
      id: "left-scene",
      label: "Left path",
      startMs: 1_000,
      endMs: 2_000,
      asset: { url: "/assets/left.mp4", version: "asset-left-v1", sourceRevision: "project-rev-12" },
      captions: { language: "en", assetVersion: "asset-left-v1", cues: [] },
      branches: [],
    },
    {
      id: "right-scene",
      label: "Right path",
      startMs: 1_000,
      endMs: 2_000,
      asset: { url: "/assets/right.mp4", version: "asset-right-v1", sourceRevision: "project-rev-12" },
      captions: { language: "en", assetVersion: "asset-right-v1", cues: [] },
      branches: [],
    },
  ],
};

/** Test fake only; it models an independently trusted host response. */
function testAuthority(
  attestedManifest: InteractiveDemoManifest,
  overrides: { actualEmbeddingOrigin?: string; sourceTruth?: InteractiveDemoManifest["sourceTruth"]; originPermissions?: InteractiveDemoManifest["originPermissions"] } = {},
): DemoHostVerificationPort {
  return {
    attest: () => ({
      manifestId: attestedManifest.id,
      revision: attestedManifest.revision,
      sha256: attestedManifest.integrity.status === "verified" ? attestedManifest.integrity.sha256 : "",
      actualEmbeddingOrigin: overrides.actualEmbeddingOrigin ?? HOST,
      sourceTruth: overrides.sourceTruth ?? attestedManifest.sourceTruth,
      originPermissions: overrides.originPermissions ?? attestedManifest.originPermissions,
    }),
  };
}

describe("interactive demo player", () => {
  it("replays branch choices and seek edits deterministically", () => {
    const actions: DemoPlayerAction[] = [
      { type: "choose-branch", branchId: "left" },
      { type: "seek", positionMs: 500 },
      { type: "choose-branch", branchId: "right" },
      { type: "seek", positionMs: 1_500 },
    ];
    const state = actions.reduce(
      (current, action) => reduceDemoPlayerState(BASE, current, action, testAuthority(BASE)),
      createDemoPlayerState(BASE, testAuthority(BASE)),
    );
    const replayed = replayDemoActions(BASE, testAuthority(BASE), actions);

    expect(state).toEqual(replayed);
    expect(state.activeSceneId).toBe("right-scene");
    expect(state.route).toEqual(["intro", "right-scene"]);
    expect(state.branches.map((visit) => visit.choiceId)).toEqual(["right"]);
    expect(state.positionMs).toBe(1_500);
    const replayedPath = replayDemoBranchPath(BASE, testAuthority(BASE), state.branches);
    expect(replayedPath.activeSceneId).toBe("right-scene");
    expect(replayedPath.positionMs).toBe(1_000);
  });

  it("fails closed when caller claims lack a matching trusted host attestation", () => {
    expect(createDemoPlayerState(BASE)).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRUST_VERIFIER_UNAVAILABLE",
    });
    expect(createDemoPlayerState(BASE, { attest: () => undefined })).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRUST_VERIFIER_UNAVAILABLE",
    });
    expect(createDemoPlayerState(BASE, { attest: () => { throw new Error("verifier offline"); } })).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRUST_VERIFIER_UNAVAILABLE",
    });

    const forgedDigest: InteractiveDemoManifest = {
      ...BASE,
      integrity: { status: "verified", sha256: "b".repeat(64), verificationRef: "bundle-verifier:demo-rev-4" },
    };
    expect(createDemoPlayerState(forgedDigest, testAuthority(BASE))).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRUST_ATTESTATION_MISMATCH",
    });
    const wrongRevision = { ...BASE, revision: "demo-rev-5" };
    expect(createDemoPlayerState(wrongRevision, testAuthority(BASE))).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRUST_ATTESTATION_MISMATCH",
    });

    const forgedLive = {
      ...BASE,
      sourceTruth: {
        kind: "live" as const,
        outputRef: "invented-output",
        outputVersion: "invented-v1",
        readbackEvidenceRef: "invented-readback",
      },
    };
    const liveState = createDemoPlayerState(forgedLive, testAuthority(BASE));
    expect(liveState.status).toBe("UNAVAILABLE");
    expect(liveState.sourceTruth).toBeUndefined();
    const originallyTrusted = createDemoPlayerState(BASE, testAuthority(BASE));
    expect(reduceDemoPlayerState(forgedLive, originallyTrusted, { type: "play" }, testAuthority(BASE))).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRUST_ATTESTATION_MISMATCH",
    });
    const forgedLiveHtml = renderToStaticMarkup(React.createElement(InteractiveDemoPlayer, {
      manifest: forgedLive,
      verificationPort: testAuthority(BASE),
    }));
    expect(forgedLiveHtml).toContain("Unverified demonstration");
    expect(forgedLiveHtml).not.toContain(">Live output<");

    const forgedPermission = {
      ...BASE,
      originPermissions: [{ origin: "https://evil.example", capabilities: ["read-asset"] as const }],
    };
    expect(createDemoPlayerState(forgedPermission, testAuthority(BASE))).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRUST_ATTESTATION_MISMATCH",
    });

    const wrongHost = { ...BASE, hostOrigin: "https://evil.example" };
    expect(createDemoPlayerState(wrongHost, testAuthority(BASE))).toMatchObject({
      status: "POLICY_DENIED",
      failure: "HOST_ORIGIN_MISMATCH",
    });
  });

  it("denies cross-origin assets without a capability bound to that exact origin", () => {
    const crossOrigin: InteractiveDemoManifest = {
      ...BASE,
      scenes: BASE.scenes.map((scene, index) => index === 0
        ? { ...scene, asset: { ...scene.asset, url: "https://cdn.example.test/intro.mp4" } }
        : scene),
    };
    const denied = createDemoPlayerState(crossOrigin, testAuthority(crossOrigin));
    expect(denied.status).toBe("POLICY_DENIED");
    expect(denied.failure).toBe("UNAUTHORIZED_ASSET_ORIGIN");

    const permitted = createDemoPlayerState({
      ...crossOrigin,
      originPermissions: [{ origin: "https://cdn.example.test", capabilities: ["read-asset"] }],
    }, testAuthority({
      ...crossOrigin,
      originPermissions: [{ origin: "https://cdn.example.test", capabilities: ["read-asset"] }],
    }));
    expect(permitted.status).toBe("READY");

    const crossOriginCaption: InteractiveDemoManifest = {
      ...BASE,
      scenes: BASE.scenes.map((scene, index) => index === 0
        ? { ...scene, captions: { ...scene.captions, sourceUrl: "https://cdn.example.test/intro.vtt" } }
        : scene),
    };
    expect(createDemoPlayerState(crossOriginCaption, testAuthority(crossOriginCaption)).failure).toBe("UNAUTHORIZED_CAPTION_ORIGIN");
    const allowedCaption: InteractiveDemoManifest = {
      ...crossOriginCaption,
      originPermissions: [{ origin: "https://cdn.example.test", capabilities: ["read-caption"] }],
    };
    expect(createDemoPlayerState(allowedCaption, testAuthority(allowedCaption)).status).toBe("READY");
  });

  it("blocks stale asset revisions and captions bound to another immutable asset", () => {
    const staleAsset = {
      ...BASE,
      scenes: BASE.scenes.map((scene, index) => index === 0
        ? { ...scene, asset: { ...scene.asset, sourceRevision: "project-rev-11" } }
        : scene),
    };
    expect(createDemoPlayerState(staleAsset, testAuthority(staleAsset))).toMatchObject({
      status: "UNAVAILABLE",
      failure: "STALE_ASSET_REVISION",
    });

    const staleCaption = {
      ...BASE,
      scenes: BASE.scenes.map((scene, index) => index === 0
        ? { ...scene, captions: { ...scene.captions, assetVersion: "asset-intro-v2" } }
        : scene),
    };
    expect(createDemoPlayerState(staleCaption, testAuthority(staleCaption))).toMatchObject({
      status: "UNAVAILABLE",
      failure: "STALE_CAPTION_ASSET_VERSION",
    });
  });

  it("leaves invalid actions unchanged and keeps branch history aligned with the reached route", () => {
    const authority = testAuthority(BASE);
    const initial = createDemoPlayerState(BASE, authority);
    expect(reduceDemoPlayerState(BASE, initial, { type: "seek", positionMs: -1 }, authority)).toEqual(initial);
    expect(reduceDemoPlayerState(BASE, initial, { type: "choose-branch", branchId: "missing" }, authority)).toEqual(initial);
    expect(reduceDemoPlayerState(BASE, initial, null as unknown as DemoPlayerAction, authority)).toEqual(initial);
    expect(reduceDemoPlayerState(BASE, initial, { type: "unknown" } as unknown as DemoPlayerAction, authority)).toEqual(initial);

    const afterLeft = reduceDemoPlayerState(BASE, initial, { type: "choose-branch", branchId: "left" }, authority);
    const rewound = reduceDemoPlayerState(BASE, afterLeft, { type: "seek", positionMs: 500 }, authority);
    const afterRight = reduceDemoPlayerState(BASE, rewound, { type: "choose-branch", branchId: "right" }, authority);
    expect(afterRight.route).toEqual(["intro", "right-scene"]);
    expect(afterRight.branches.map((visit) => visit.toSceneId)).toEqual(["right-scene"]);
    expect(afterRight.history).toHaveLength(3);
  });

  it("selects captions deterministically with half-open cue boundaries", () => {
    const scene = BASE.scenes[0];
    expect(demoCaptionAt(scene, -1)).toBe("");
    expect(demoCaptionAt(scene, 0)).toBe("Choose a path.");
    expect(demoCaptionAt(scene, 599.9)).toBe("Choose a path.");
    expect(demoCaptionAt(scene, 600)).toBe("");
    expect(demoCaptionAt(scene, Number.NaN)).toBe("");
  });

  it("bounds authored branch loops without diverging route and branch history", () => {
    const loopManifest: InteractiveDemoManifest = {
      ...BASE,
      scenes: BASE.scenes.map((scene, index) => index === 0
        ? { ...scene, branches: [{ id: "loop", label: "Repeat introduction", targetSceneId: "intro" }] }
        : scene),
    };
    const authority = testAuthority(loopManifest);
    const actions: DemoPlayerAction[] = Array.from({ length: 256 }, () => ({ type: "choose-branch", branchId: "loop" }));
    const state = replayDemoActions(loopManifest, authority, actions);

    expect(state.status).toBe("UNAVAILABLE");
    expect(state.failure).toBe("PLAYBACK_LIMIT_REACHED");
    expect(state.route).toHaveLength(256);
    expect(state.branches).toHaveLength(state.route.length - 1);
    expect(state.history).toHaveLength(state.branches.length);
  });

  it("does not label simulations or curated demonstrations as live output", () => {
    expect(demoSourceTruthLabel({ kind: "simulation" })).toBe("Simulated demonstration");
    expect(demoSourceTruthLabel({ kind: "curated", curationRef: "curation:demo-v2" })).toBe("Curated demonstration");
    expect(demoSourceTruthLabel({
      kind: "live",
      outputRef: "output:42",
      outputVersion: "v7",
      readbackEvidenceRef: "owner-readback:42:v7",
    })).toBe("Live output");
    const attestedLive = {
      ...BASE,
      sourceTruth: {
        kind: "live" as const,
        outputRef: "output:42",
        outputVersion: "v7",
        readbackEvidenceRef: "owner-readback:42:v7",
      },
    };
    expect(createDemoPlayerState(attestedLive, testAuthority(attestedLive)).sourceTruth).toEqual(attestedLive.sourceTruth);
    expect(demoSourceTruthLabel({ kind: "live", outputRef: "", outputVersion: "" })).toBe("Live output unverified");
    expect(createDemoPlayerState({
      ...BASE,
      sourceTruth: { kind: "live", outputRef: "output:42", outputVersion: "v7", readbackEvidenceRef: "" },
    }, testAuthority({
      ...BASE,
      sourceTruth: { kind: "live", outputRef: "output:42", outputVersion: "v7", readbackEvidenceRef: "" },
    })).failure).toBe("LIVE_OUTPUT_EVIDENCE_MISSING");
  });

  it("shows curated and live source labels only when the host fake attests the exact source evidence", () => {
    const curated: InteractiveDemoManifest = {
      ...BASE,
      sourceTruth: { kind: "curated", curationRef: "curation:demo-v2" },
    };
    const curatedHtml = renderToStaticMarkup(React.createElement(InteractiveDemoPlayer, {
      manifest: curated,
      verificationPort: testAuthority(curated),
    }));
    expect(curatedHtml).toContain('aria-label="Source: Curated demonstration"');
    expect(curatedHtml).not.toContain(">Live output<");

    const live: InteractiveDemoManifest = {
      ...BASE,
      sourceTruth: {
        kind: "live",
        outputRef: "output:42",
        outputVersion: "v7",
        readbackEvidenceRef: "owner-readback:42:v7",
      },
    };
    const liveHtml = renderToStaticMarkup(React.createElement(InteractiveDemoPlayer, {
      manifest: live,
      verificationPort: testAuthority(live),
    }));
    expect(liveHtml).toContain('aria-label="Source: Live output"');
    expect(liveHtml).not.toContain("Simulated demonstration");
  });

  it("renders native keyboard-operable controls and a concise status live region", () => {
    const html = renderToStaticMarkup(React.createElement(InteractiveDemoPlayer, {
      manifest: BASE,
      verificationPort: testAuthority(BASE),
    }));

    expect(html).toContain('aria-label="Interactive demonstration player"');
    expect(html).toContain('aria-label="Playback controls"');
    expect(html).toContain('aria-label="Seek within Introduction"');
    expect(html).toContain('aria-label="Explore left path; continue to Left path"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('<button type="button"');
    expect(html).toContain('<input type="range"');
    expect(html).toContain("Simulated demonstration");
    expect(html).not.toContain("tabindex=\"-1\"");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("src=");
  });

  it("withholds keyboard-operable actions when policy denies a cross-origin asset", () => {
    const deniedManifest: InteractiveDemoManifest = {
      ...BASE,
      scenes: BASE.scenes.map((scene, index) => index === 0
        ? { ...scene, asset: { ...scene.asset, url: "https://untrusted.example/intro.mp4" } }
        : scene),
    };
    const html = renderToStaticMarkup(React.createElement(InteractiveDemoPlayer, {
      manifest: deniedManifest,
      verificationPort: testAuthority(deniedManifest),
    }));
    expect(html).toContain('data-demo-status="POLICY_DENIED"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).not.toContain("Playback controls");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('type="range"');
  });
});
