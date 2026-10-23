#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_F00_T01_OBSERVATION_PATH, deriveMediaGtoolExecutionQueue } from './lib/media-gtool-execution-queue.mjs';
import { checkF00T01Observation } from './lib/media-build-f00-t01-observation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queuePath = path.join(root, 'docs/implementation/MEDIA-GTOOL-EXECUTION-QUEUE.v2.json');
const dispositionsPath = path.join(root, 'docs/implementation/MEDIA-GTOOL-OWNER-EXECUTION-DISPOSITIONS.v1.json');
const inventoryPath = path.join(root, 'docs/implementation/MEDIA-BUILD-BRIDGE-BLOCKER-INVENTORY.v1.json');
const executionAuthorizationPath = 'config/closure/media-product-definition/owner-execution-authorization.v1.json';
const defaultObservationPath = DEFAULT_F00_T01_OBSERVATION_PATH;
const args = process.argv.slice(2);
let checkOnly = false;
let observationPath = defaultObservationPath;
let g0StatusPath;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--check' && !checkOnly) checkOnly = true;
  else if (arg === '--f00-observation' && args[index + 1]) observationPath = args[++index];
  else if (arg === '--g0-status' && args[index + 1]) g0StatusPath = args[++index];
  else {
    console.error('Usage: node scripts/generate-media-gtool-execution-queue.mjs [--check] [--f00-observation <path>] [--g0-status <Lifecycle status JSON>]');
    process.exit(2);
  }
}
if (!observationPath) {
  console.error('CURRENT_F00_T01_SOURCE_OBSERVATION_REQUIRED');
  process.exit(2);
}

function readJson(filePath) {
  const bytes = fs.readFileSync(filePath, 'utf8');
  return { bytes, value: JSON.parse(bytes) };
}

const { bytes: queueBytes, value: queue } = readJson(queuePath);
const { bytes: dispositionBytes, value: dispositions } = readJson(dispositionsPath);
const { bytes: inventoryBytes, value: inventory } = readJson(inventoryPath);
const { bytes: executionAuthorizationBytes, value: executionAuthorization } = readJson(path.join(root, executionAuthorizationPath));
const { bytes: observationBytes, value: observation } = readJson(path.resolve(root, observationPath));
const selectedG0StatusPath = g0StatusPath ?? observation.sourceBaseline?.g0Status?.path;
if (!selectedG0StatusPath) throw new Error('CURRENT_G0_STATUS_PATH_REQUIRED');
checkF00T01Observation({ root, g0StatusPath: selectedG0StatusPath, artifactPath: observationPath });
const derived = deriveMediaGtoolExecutionQueue(
  queue, dispositions, dispositionBytes, inventory, inventoryBytes, observation, observationBytes,
  executionAuthorization, executionAuthorizationBytes, observationPath, executionAuthorizationPath,
);
const output = `${JSON.stringify(derived, null, 2)}\n`;

if (checkOnly) {
  if (queueBytes !== output) {
    console.error('Media gtool execution queue is stale; run pnpm run generate:gtool-execution-queue.');
    process.exitCode = 1;
  } else {
    console.log('Media gtool execution queue is current.');
  }
} else {
  fs.writeFileSync(queuePath, output);
  console.log('Updated derived Media gtool execution queue.');
}

console.log(JSON.stringify({
  taskCount: derived.tasks.length,
  openTechnicalTaskCount: derived.tasks.filter(task => task.status === 'OPEN_TECHNICAL_WORK').length,
  executionAuthorization: {
    decisionId: derived.executionAuthorization.decisionId,
    revision: derived.executionAuthorization.ownerDecisionRevision,
    digest: derived.executionAuthorization.sha256,
    boundary: derived.executionAuthorization.boundary,
  },
  sourceTraceIdentities: derived.campaign.sourceTraceIdentities,
  bridge: {
    traceIdentityCount: derived.bridge.traceIdentityCount,
    sourceBridgeEdgeCount: derived.bridge.sourceBridgeEdgeCount,
    unresolvedSourceBlockerCount: derived.bridge.unresolvedSourceBlockerCount,
    p1OperationMissingReferenceCount: derived.bridge.p1OperationMissingReferenceCount,
    unresolvedCrossLayerRelationCount: derived.bridge.unresolvedCrossLayerRelationCount,
    unresolvedHandoffSelectorCount: derived.bridge.unresolvedHandoffSelectorCount,
    sourceBridgeStatus: derived.bridge.sourceBridgeStatus,
  },
}, null, 2));
