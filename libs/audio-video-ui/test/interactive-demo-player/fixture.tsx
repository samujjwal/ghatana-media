import { createRoot } from "react-dom/client";
import {
  InteractiveDemoPlayer,
  type DemoHostAttestation,
  type DemoHostVerificationPort,
  type DemoScene,
  type InteractiveDemoManifest,
} from "@audio-video/ui";

declare const __LOCAL_PREVIEW_FIXTURE__: {
  readonly sourceVersion: string;
  readonly previewManifestSha256: string;
  readonly audioSha256: string;
  readonly durationMs: number;
};

const fixture = __LOCAL_PREVIEW_FIXTURE__;
const origin = window.location.origin;
const deniedOrigin = "https://unapproved-origin.invalid";
const scenario = new URLSearchParams(window.location.search).get("denied");
const assetVersion = `sha256:${fixture.audioSha256}`;
const midpoint = Math.floor(fixture.durationMs / 2);
const firstPassage = Math.floor(midpoint / 2);
const assetUrl = "/interactive-demo-preview.wav";
const asset = {
  url: scenario === "asset" ? `${deniedOrigin}${assetUrl}` : assetUrl,
  version: assetVersion,
  sourceRevision: fixture.sourceVersion,
  mediaKind: "audio" as const,
};
const captions = {
  language: "en",
  assetVersion,
  ...(scenario === "caption" ? { sourceUrl: `${deniedOrigin}/preview.vtt` } : {}),
};
const scenes: readonly DemoScene[] = [
  {
    id: "intro",
    label: "Introduction",
    startMs: 0,
    endMs: fixture.durationMs,
    asset,
    captions: {
      ...captions,
      cues: [
        { id: "intro-start", startMs: 0, endMs: midpoint, text: "Opening tone." },
        { id: "intro-end", startMs: midpoint, endMs: fixture.durationMs, text: "Closing tone." },
      ],
    },
    branches: [
      { id: "first", label: "Hear the first passage", targetSceneId: "first-passage" },
      { id: "second", label: "Hear the second passage", targetSceneId: "second-passage" },
    ],
  },
  {
    id: "first-passage",
    label: "First passage",
    startMs: firstPassage,
    endMs: midpoint,
    asset,
    captions: {
      ...captions,
      cues: [{ id: "first-passage", startMs: firstPassage, endMs: midpoint, text: "First passage tone." }],
    },
    branches: [],
  },
  {
    id: "second-passage",
    label: "Second passage",
    startMs: midpoint,
    endMs: fixture.durationMs,
    asset,
    captions: {
      ...captions,
      cues: [{ id: "second-passage", startMs: midpoint, endMs: fixture.durationMs, text: "Second passage tone." }],
    },
    branches: [],
  },
];

const manifestBody = {
  id: "local-creative-preview-player",
  revision: `sha256:${fixture.previewManifestSha256}`,
  sourceRevision: fixture.sourceVersion,
  hostOrigin: origin,
  sourceTruth: { kind: "simulation" },
  originPermissions: scenario === "asset"
    ? [{ origin: deniedOrigin, capabilities: ["read-caption"] }]
    : scenario === "caption"
      ? [{ origin: deniedOrigin, capabilities: ["read-asset"] }]
      : [],
  initialSceneId: "intro",
  scenes,
} satisfies Omit<InteractiveDemoManifest, "integrity">;
const bundleBytes = new TextEncoder().encode(JSON.stringify(manifestBody));
const hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bundleBytes));
const sha256 = Array.from(hashBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const manifest: InteractiveDemoManifest = {
  ...manifestBody,
  integrity: { status: "verified", sha256, verificationRef: "local-browser-test-only" },
};
// This fixed fixture snapshot only exercises the local player's verification seam.
const attestation: DemoHostAttestation = {
  manifestId: manifest.id,
  revision: manifest.revision,
  sha256,
  actualEmbeddingOrigin: origin,
  sourceTruth: manifest.sourceTruth,
  originPermissions: manifest.originPermissions,
};
const verificationPort: DemoHostVerificationPort = {
  attest: (candidate) => candidate === manifest ? attestation : undefined,
};

const container = document.getElementById("preview");
if (!container) throw new Error("Missing local creative preview mount.");
createRoot(container).render(
  <>
    <h1>Local creative preview player</h1>
    <p>LOCAL_PREVIEW_ONLY · Synthetic tone · Local test verifier</p>
    <InteractiveDemoPlayer manifest={manifest} verificationPort={verificationPort} />
  </>,
);
