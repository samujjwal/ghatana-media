#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRepositorySourceCurrentness } from '@ghatana/verification-planner';
import { joinMediaPdp0PhaseExit } from './lib/media-discovery-pdp0-phase-exit.mjs';
import { buildMediaPdp0CurrentnessObservation } from './record-media-discovery-pdp0-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOwnerInput = 'docs/implementation/observations/media-discovery-delegated-owner-acceptance-pdp0-2026-10-13-r2.json';
const suffix = process.argv[2] ?? '2026-10-13-r2';
const outcomesPath = process.argv[3];

if (!/^[a-z0-9-]+$/u.test(suffix) || !outcomesPath) {
  process.stderr.write('Usage: node scripts/record-media-discovery-pdp0-phase-exit.mjs <fresh-cut-suffix> <test-outcomes-json>\n');
  process.exitCode = 2;
} else {
  const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.resolve(root, relativePath), 'utf8'));
  const outcomeRecord = JSON.parse(fs.readFileSync(path.resolve(outcomesPath), 'utf8'));
  if (!Array.isArray(outcomeRecord.testOutcomes)) throw new TypeError('Test-outcomes JSON must contain a testOutcomes array');

  // The first build gives the exact dimension set and allows Lifecycle to
  // observe the just-committed repository membership before the final capture.
  const initial = buildMediaPdp0CurrentnessObservation({ preserveExistingObservedAt: false }).observation;
  const firstCell = initial.physicalCompositeConsumerCells[0];
  const dimensions = {
    ownerGraphFingerprint: firstCell?.ownerGraphFingerprint,
    physicalCatalogFingerprint: firstCell?.physicalCatalogFingerprint,
    providerRegistryFingerprint: firstCell?.providerRegistryFingerprint,
  };
  if (Object.values(dimensions).some((value) => !/^sha256:[a-f0-9]{64}$/u.test(value ?? ''))) {
    throw new Error('The current PDP-0 fingerprint dimensions are incomplete');
  }
  const lifecyclePriming = [
    captureRepositorySourceCurrentness(root, dimensions),
    captureRepositorySourceCurrentness(root, dimensions),
  ].map((capture) => ({
    status: capture.status,
    freshness: capture.freshness,
    continuity: capture.journal?.continuity ?? 'UNKNOWN',
    membershipChangeState: capture.journal?.membershipChangeState ?? 'UNKNOWN',
    additions: capture.journal?.membershipAdditions?.length ?? null,
    removals: capture.journal?.membershipRemovals?.length ?? null,
    changedPathCount: capture.journal?.changedPaths?.length ?? null,
  }));
  const { observation: technicalCurrentness } = buildMediaPdp0CurrentnessObservation({ preserveExistingObservedAt: false });
  technicalCurrentness.observationId = `MEDIA-PDP0-CURRENTNESS-${suffix.toUpperCase()}`;
  technicalCurrentness.capturePreparation = {
    lifecyclePriming,
    purpose: 'Establish a stable post-commit Lifecycle source snapshot before the exact phase-cell capture.',
  };
  const ownerAcceptance = readJson(defaultOwnerInput);
  const baselineSha = technicalCurrentness.campaign.observedHead;
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness,
    ownerAcceptance,
    testOutcomes: outcomeRecord.testOutcomes,
    baselineSha,
  });
  const technicalPath = `docs/implementation/observations/media-discovery-pdp0-currentness-${suffix}.json`;
  const exitPath = `docs/implementation/observations/media-discovery-pdp0-exit-${suffix}.json`;
  for (const relativePath of [technicalPath, exitPath]) {
    if (fs.existsSync(path.resolve(root, relativePath))) throw new Error(`Refusing to overwrite immutable observation: ${relativePath}`);
  }
  const writeImmutable = (relativePath, value) => {
    const absolute = path.resolve(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const fd = fs.openSync(absolute, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  };
  writeImmutable(technicalPath, technicalCurrentness);
  writeImmutable(exitPath, exit);
  process.stdout.write(`${JSON.stringify({ technicalPath, exitPath, phaseExit: exit.phaseExit, lifecyclePriming }, null, 2)}\n`);
  if (exit.phaseExit.status !== 'PASS') process.exitCode = 1;
}
