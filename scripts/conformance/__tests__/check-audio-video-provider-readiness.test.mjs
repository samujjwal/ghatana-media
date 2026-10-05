import assert from "node:assert/strict";
import test from "node:test";

import { findAudioVideoProviderReadinessViolations } from "../check-audio-video-provider-readiness.mjs";

test("Audio-Video provider readiness passes on current repository evidence", () => {
  assert.deepEqual(findAudioVideoProviderReadinessViolations(), []);
});
