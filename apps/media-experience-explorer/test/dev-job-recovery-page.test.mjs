import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("job recovery page is DEV_ONLY and delegates owner reads to canonical UI/SDK", async () => {
  const [html, source, vite, main] = await Promise.all([
    readFile(resolve(root, "dev-job-recovery.html"), "utf8"),
    readFile(resolve(root, "src/dev-job-recovery.tsx"), "utf8"),
    readFile(resolve(root, "vite.config.mjs"), "utf8"),
    readFile(resolve(root, "src/main.ts"), "utf8"),
  ]);
  assert.match(html, /DEV_ONLY · owner scoped/u);
  assert.match(source, /new MediaCanonicalClient/u);
  assert.match(source, /JobRecoveryScreen/u);
  assert.match(source, /getAccessToken: \(\) => token/u);
  assert.match(source, /renderedJobId = jobId/u);
  assert.doesNotMatch(source, /\.cancelJob\(|\.createJob\(|\/cancel/u);
  assert.match(vite, /@audio-video\/client\/canonical-operations/u);
  assert.match(vite, /request\.method !== "GET"/u);
  assert.match(vite, /"\/api\/v1\/jobs"/u);
  assert.doesNotMatch(vite, /devJobRecovery:\s*resolve\(appRoot, "dev-job-recovery\.html"\)/u,
    "the DEV_ONLY page must not be part of production build inputs");
  assert.match(main, /import\.meta\.env\.DEV[\s\S]*dev-job-recovery\.html/u,
    "the Explorer navigation link must remain development-only");
});
