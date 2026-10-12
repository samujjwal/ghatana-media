import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScreenStatusMatrix,
  parseComponentIds,
  parseLocalSimulationIds,
  parseRegistryScreens,
} from "./lib/media-screen-status-matrix.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, ".product-experience/pdp-3-product-experience/screen-registry.yaml");
const componentPath = path.join(root, "libs/audio-video-ui/src/screens/MediaContractScreen.tsx");
const rendererPath = path.join(root, "libs/audio-video-ui/src/screens/MediaProductRenderer.tsx");
const outputPath = path.join(root, "docs/implementation/evidence/media-screen-status-matrix-2026-10-12.json");
const [registry, componentSource, rendererSource] = await Promise.all([
  readFile(registryPath, "utf8"),
  readFile(componentPath, "utf8"),
  readFile(rendererPath, "utf8"),
]);
const contractRoute = rendererSource.match(/"contract-screen":\s*\{\s*renderer:\s*"DEFINITION_ONLY_PREVIEW",\s*productRoute:\s*"([A-Z_]+)"\s*\}/u)?.[1];
if (!contractRoute) throw new Error("MediaProductRenderer contract-screen route disposition is unresolved");
const rendererRouteAdmissions = [...rendererSource.matchAll(/productRoute:\s*"([A-Z_]+)"/gu)].map((match) => match[1]);
if (!rendererRouteAdmissions.length || rendererRouteAdmissions.some((status) => status !== "NOT_ADMITTED")) {
  throw new Error("Every renderer route disposition must remain NOT_ADMITTED");
}
const matrix = buildScreenStatusMatrix({
  registryScreens: parseRegistryScreens(registry),
  componentIds: parseComponentIds(componentSource),
  localSimulationIds: parseLocalSimulationIds(rendererSource),
  contractPreviewProductRoute: contractRoute,
});
const result = {
  schemaVersion: "media.screen-status-matrix.v1",
  sourceRegistry: ".product-experience/pdp-3-product-experience/screen-registry.yaml",
  observationScope: "local Explorer and Media renderer source; not production deployment or product route admission",
  counts: matrix.reduce((counts, { status }) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {}),
  screens: matrix,
};
const contents = `${JSON.stringify(result, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== contents) throw new Error("Screen status matrix is stale; run pnpm generate:screen-status-matrix");
  process.stdout.write(`Screen status matrix current: ${matrix.length} screens\n`);
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents);
  process.stdout.write(`Generated ${path.relative(root, outputPath)} (${matrix.length} screens)\n`);
}
