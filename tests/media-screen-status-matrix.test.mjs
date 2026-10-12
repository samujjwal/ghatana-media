import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildScreenStatusMatrix,
  parseComponentIds,
  parseLocalSimulationIds,
  parseRegistryScreens,
} from "../scripts/lib/media-screen-status-matrix.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("generated screen status matrix exactly covers canonical 47 screen registry", async () => {
  const [registrySource, components, renderer, main, productReview, output] = await Promise.all([
    read("../.product-experience/pdp-3-product-experience/screen-registry.yaml"),
    read("../libs/audio-video-ui/src/screens/MediaContractScreen.tsx"),
    read("../libs/audio-video-ui/src/screens/MediaProductRenderer.tsx"),
    read("../apps/media-experience-explorer/src/main.ts"),
    read("../apps/media-experience-explorer/src/product-review.tsx"),
    read("../docs/implementation/evidence/media-screen-status-matrix-2026-10-12.json"),
  ]);
  const registryScreens = parseRegistryScreens(registrySource);
  const previewProductRoute = renderer.match(/"contract-screen":\s*\{\s*renderer:\s*"DEFINITION_ONLY_PREVIEW",\s*productRoute:\s*"([A-Z_]+)"\s*\}/u)?.[1];
  const matrix = buildScreenStatusMatrix({
    registryScreens,
    componentIds: parseComponentIds(components),
    localSimulationIds: parseLocalSimulationIds(renderer),
    contractPreviewProductRoute: previewProductRoute,
  });
  const generated = JSON.parse(output);
  assert.equal(registryScreens.length, 47);
  assert.deepEqual(generated.screens, matrix);
  assert.deepEqual(generated.counts, { LOCAL_SIMULATION: 12, CONTRACT_PREVIEW: 35 });
  assert.ok(generated.screens.every(({ productRoute, networkCapability }) => productRoute === "NOT_ADMITTED" && networkCapability === "NOT_CLAIMED"));
  assert.match(main, /if \(location\.hash\.startsWith\("#product\/view\/"\)\) return "specification";/u);
  assert.match(main, /No Product route or implementation is implied\./u);
  assert.match(productReview, /This synthetic fixture is not a production service or admitted Web screen\./u);
});

test("negative cases reject missing, extra, and duplicate IDs plus preview route/network claims", async () => {
  const [registrySource, components, renderer] = await Promise.all([
    read("../.product-experience/pdp-3-product-experience/screen-registry.yaml"),
    read("../libs/audio-video-ui/src/screens/MediaContractScreen.tsx"),
    read("../libs/audio-video-ui/src/screens/MediaProductRenderer.tsx"),
  ]);
  const registryScreens = parseRegistryScreens(registrySource);
  const componentIds = parseComponentIds(components);
  const localSimulationIds = parseLocalSimulationIds(renderer);
  const valid = { registryScreens, componentIds, localSimulationIds, contractPreviewProductRoute: "NOT_ADMITTED" };
  assert.throws(() => buildScreenStatusMatrix({ ...valid, componentIds: componentIds.slice(1) }), /Screen\/component mismatch; missing:/u);
  assert.throws(() => buildScreenStatusMatrix({ ...valid, componentIds: [...componentIds, "media.view.unregistered"] }), /Screen\/component mismatch; missing: none; extra:/u);
  assert.throws(() => buildScreenStatusMatrix({ ...valid, componentIds: [...componentIds, componentIds[0]] }), /duplicate screen IDs/u);
  assert.throws(() => buildScreenStatusMatrix({ ...valid, contractPreviewProductRoute: "ADMITTED" }), /preview routes cannot claim runtime or network capability/u);
  assert.throws(() => buildScreenStatusMatrix({ ...valid, contractPreviewNetworkCapability: "AVAILABLE" }), /preview routes cannot claim runtime or network capability/u);
});
