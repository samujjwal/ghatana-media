import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATION_PARITY_PATH,
  OWNER_CANDIDATE_PATH,
  refreshMpsem0023C002Observation,
} from "./lib/media-mpsem-0023-c002-observation-refresh.mjs";

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  process.stderr.write("Usage: node scripts/refresh-media-mpsem-0023-c002-observation.mjs --check|--write\n");
  process.exit(2);
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(repositoryRoot, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const candidatePath = resolve(repositoryRoot, OWNER_CANDIDATE_PATH);
const sourceText = readFileSync(resolve(repositoryRoot, OPERATION_PARITY_PATH), "utf8");
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
const operationParity = parse(sourceText);
const routeManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "config/route-manifest.json"), "utf8"));
const result = refreshMpsem0023C002Observation({ candidate, sourceText, operationParity, routeManifest });

if (mode === "--write" && result.changed) {
  writeFileSync(candidatePath, `${JSON.stringify(result.candidate, null, 2)}\n`);
  process.stdout.write(`Refreshed pending MPSEM-0023-C002 source observation: ${result.sourceSha256}\n`);
} else if (mode === "--check" && result.changed) {
  process.stderr.write(`MPSEM-0023-C002 source observation is stale; proposed current digest: ${result.sourceSha256}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`MPSEM-0023-C002 source observation is current: ${result.sourceSha256}\n`);
}
