import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applySimulationEvent,
  createFixtureState,
  mediaExperienceScenarioIds,
  projectJson,
  reduceMediaExperience,
} from "../../../libs/media-experience-simulation/dist/index.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const mainSource = readFileSync(resolve(appRoot, "src/main.ts"), "utf8");
const viteConfigSource = readFileSync(resolve(appRoot, "vite.config.mjs"), "utf8");

function cspDirectives(name) {
  const match = viteConfigSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join\\("; "\\)`, "u"));
  assert.ok(match, `${name} exists in vite.config.mjs`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map(([, directive]) => directive);
}

test("dev and preview CSP stay strict with no wildcard, inline, or eval escape", () => {
  const dev = cspDirectives("contentSecurityPolicy");
  assert.ok(dev.includes("default-src 'self'"));
  assert.ok(dev.includes("script-src 'self'"));
  assert.ok(dev.includes("object-src 'none'"));
  assert.ok(dev.includes("frame-ancestors 'none'"));
  for (const directive of dev) {
    assert.ok(!directive.includes("unsafe-inline"), directive);
    assert.ok(!directive.includes("unsafe-eval"), directive);
    assert.ok(!directive.includes("*"), directive);
  }
  // Dev allows the HMR websocket; preview removes it — never broadens.
  // The only widening is the exact configured OIDC issuer origin, and only when both OIDC settings are present.
  assert.ok(viteConfigSource.includes("`connect-src 'self'${oidcConnectSource} ws://127.0.0.1:4178`"));
  assert.ok(viteConfigSource.includes("`connect-src 'self'${oidcConnectSource}`"));
  assert.ok(viteConfigSource.includes("new URL(oidcIssuer).origin"));
});

test("simulated state is always labeled and never implies backend admission", () => {
  assert.ok(mainSource.includes("Synthetic fixture"), "fixture badge marks simulated state");
  assert.ok(mainSource.includes("Explorer only"), "fixture controls stay scoped to the Explorer");
  // Admission wording may only appear negated: "NOT ADMITTED" or "unadmitted".
  for (const mention of mainSource.matchAll(/([A-Za-z_]*admit[A-Za-z_]*)/giu)) {
    const word = mention[1].toLowerCase().replace(/[^a-z]/gu, "");
    const negated = word === "unadmitted" || word === "notadmitted" || word === "nonadmitted"
      || mainSource.slice(Math.max(0, mention.index - 12), mention.index).toUpperCase().includes("NOT ");
    assert.ok(negated, `admission wording '${mention[1]}' must stay negated — Explorer never implies backend admission`);
  }
  // The only network read is the bundled specification/ asset projection —
  // the app has no live-service dependency.
  for (const call of mainSource.matchAll(/fetch\(([^)]+)\)/gu)) {
    assert.ok(/sourceUrl|specification\//u.test(call[1]),
      `Explorer fetch target ${call[1]} must be a bundled specification asset, not a live backend`);
  }
  assert.ok(!/fetch\(\s*["'`]\s*https?:/u.test(mainSource), "no fetch to an external origin");
  assert.ok(!mainSource.includes("/api/v1/"), "no live Media API endpoint usage");
});

test("scenario replay is deterministic across every authored fixture id", () => {
  for (const scenarioId of mediaExperienceScenarioIds) {
    const actions = [
      { type: "media.action.start-artifact-intake" },
      { type: "media.action.submit-job" },
    ];
    const events = [
      { type: "job.started" },
      { type: "job.completed" },
    ];
    const run = () => {
      let state = createFixtureState(scenarioId);
      for (const action of actions) state = reduceMediaExperience(state, action).state;
      for (const event of events) state = applySimulationEvent(state, event).state;
      return projectJson(state);
    };
    assert.equal(run(), run(), `${scenarioId} must replay deterministically`);
  }
});

test("caption fixtures stay synchronized to the declared source duration and ordering", () => {
  for (const scenarioId of mediaExperienceScenarioIds) {
    const state = createFixtureState(scenarioId);
    if (state.workflow !== "transcription") continue;
    const duration = state.source.durationTicks;
    const tps = state.source.ticksPerSecond;
    assert.ok(duration > 0 && tps > 0, `${scenarioId} declares a rational source duration`);
    let lastEnd = -1;
    for (const segment of state.transcript.segments) {
      if (segment.startTick != null && segment.endTick != null) {
        assert.ok(segment.startTick >= lastEnd, `${scenarioId} ${segment.segmentId} stays ordered`);
        assert.ok(segment.endTick > segment.startTick, `${scenarioId} ${segment.segmentId} is non-empty`);
        assert.ok(segment.endTick <= duration, `${scenarioId} ${segment.segmentId} fits the source duration`);
        lastEnd = segment.endTick;
      }
    }
  }
});
