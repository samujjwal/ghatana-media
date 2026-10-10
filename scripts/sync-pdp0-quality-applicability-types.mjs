#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const capabilityPath = resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml");
const qualityPath = resolve(root, ".product-experience/pdp-0-product-truth/quality-policy.yaml");

const [capabilityText, qualityText] = await Promise.all([
  readFile(capabilityPath, "utf8"),
  readFile(qualityPath, "utf8"),
]);
const capabilities = parse(capabilityText).capabilities;
const policy = parse(qualityText);
const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
const crosswalk = policy.ownerQualityApplicabilityCrosswalk;
if (capabilities.length !== 462 || crosswalk?.records?.length !== capabilities.length) {
  throw new Error("P0 quality applicability must cover the exact 462 capability intents");
}

const recordsStart = qualityText.indexOf("ownerQualityApplicabilityCrosswalk:");
if (recordsStart < 0) throw new Error("P0 owner quality applicability crosswalk is missing");
let changed = 0;
const output = qualityText.split("\n").map((line) => {
  if (!line.startsWith("    - {\"id\":\"media.quality-applicability.")) return line;
  const row = JSON.parse(line.slice(line.indexOf("{")).trim());
  const capability = byId.get(row.capabilityRef);
  if (!capability) throw new Error(`Unknown P0 capability intent ${row.capabilityRef}`);
  const inputSet = new Set(capability.inputArtifactTypes);
  const outputSet = new Set(capability.outputArtifactTypes);
  for (const metric of Object.values(row.metricApplicability)) {
    metric.subjectInputArtifactTypes = metric.subjectInputArtifactTypes.filter((type) => inputSet.has(type));
    metric.subjectOutputArtifactTypes = metric.subjectOutputArtifactTypes.filter((type) => outputSet.has(type));
  }
  if (JSON.stringify(row.inputArtifactTypes) === JSON.stringify(capability.inputArtifactTypes)
    && JSON.stringify(row.outputArtifactTypes) === JSON.stringify(capability.outputArtifactTypes)
    && JSON.stringify(row.metricApplicability) === JSON.stringify(crosswalk.records.find((record) => record.capabilityRef === row.capabilityRef)?.metricApplicability)) return line;
  row.inputArtifactTypes = capability.inputArtifactTypes;
  row.outputArtifactTypes = capability.outputArtifactTypes;
  changed += 1;
  return `    - ${JSON.stringify(row)}`;
}).join("\n");

if (changed) await writeFile(qualityPath, output);
console.log(`Synchronized P0 semantic artifact types for ${changed} quality applicability records.`);
