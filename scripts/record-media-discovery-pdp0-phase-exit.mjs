#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRepositorySourceCurrentness } from '@ghatana/verification-planner';
import { joinMediaPdp0PhaseExit, parseMediaPdp0PhaseExitArgs, resolveMediaPdp0SuccessorPredecessorRefs } from './lib/media-discovery-pdp0-phase-exit.mjs';
import { buildMediaPdp0CurrentnessObservation } from './record-media-discovery-pdp0-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOwnerInput = 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json';
const legacyHistoricalPdp0ExitInput = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-13-r2.json';
const currentCutHistoricalPdp0ExitInput = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json';
const currentCutImpactInput = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json';
const r8HistoricalPdp0ExitInput = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r8.json';
const r10HistoricalPdp0ExitInput = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json';
const r11HistoricalPdp0ExitInput = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json';
const { suffix, outcomesPath, currentCutImpactMode, additionalImpactPath, successorImpactMode, successorImpactPath, legacyOwnerInputPath } = parseMediaPdp0PhaseExitArgs(process.argv);
const ownerInput = currentCutImpactMode ? currentCutImpactInput : successorImpactMode ? successorImpactPath : legacyOwnerInputPath ?? defaultOwnerInput;
const successorPredecessorRefs = successorImpactMode
  ? resolveMediaPdp0SuccessorPredecessorRefs(JSON.parse(fs.readFileSync(path.resolve(root, ownerInput), 'utf8')).recordId)
  : null;
const historicalPdp0ExitInput = currentCutImpactMode ? currentCutHistoricalPdp0ExitInput : successorImpactMode
  ? successorPredecessorRefs.exitRef
  : legacyHistoricalPdp0ExitInput;

if (!/^[a-z0-9-]+$/u.test(suffix) || !outcomesPath) {
  process.stderr.write('Usage: node scripts/record-media-discovery-pdp0-phase-exit.mjs <fresh-cut-suffix> <test-outcomes-json> [owner-directions-json|--current-cut-impact <additional-source-impact-json>|--successor-impact <successor-impact-json>]\n');
  process.exitCode = 2;
} else {
  const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.resolve(root, relativePath), 'utf8'));
  const outcomeRecord = JSON.parse(fs.readFileSync(path.resolve(outcomesPath), 'utf8'));
  if (!Array.isArray(outcomeRecord.testOutcomes)) throw new TypeError('Test-outcomes JSON must contain a testOutcomes array');
  const technicalPath = `docs/implementation/observations/media-discovery-pdp0-currentness-${suffix}.json`;
  const exitPath = `docs/implementation/observations/media-discovery-pdp0-exit-${suffix}.json`;
  for (const relativePath of [technicalPath, exitPath]) {
    if (fs.existsSync(path.resolve(root, relativePath))) throw new Error(`Refusing to overwrite immutable observation: ${relativePath}`);
  }

  // The first build gives the exact dimension set and allows Lifecycle to
  // observe the just-committed repository membership before the final capture.
  const initial = buildMediaPdp0CurrentnessObservation({ preserveExistingObservedAt: false, additionalImpactPath, successorImpactPath,
    observationOutputPath: technicalPath }).observation;
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
  const { observation: technicalCurrentness } = buildMediaPdp0CurrentnessObservation({ preserveExistingObservedAt: false, additionalImpactPath, successorImpactPath,
    observationOutputPath: technicalPath });
  if (!successorImpactMode) technicalCurrentness.observationId = `MEDIA-PDP0-CURRENTNESS-${suffix.toUpperCase()}`;
  technicalCurrentness.capturePreparation = {
    lifecyclePriming,
    purpose: 'Establish a stable post-commit Lifecycle source snapshot before the exact phase-cell capture.',
  };
  const ownerAcceptance = readJson(ownerInput);
  const additionalSourceImpact = additionalImpactPath ? readJson(additionalImpactPath) : null;
  const historicalPdp0Exit = readJson(historicalPdp0ExitInput);
  const baselineSha = technicalCurrentness.campaign.observedHead;
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness,
    ownerAcceptance,
    ownerAcceptancePath: ownerInput,
    additionalSourceImpact,
    additionalSourceImpactPath: additionalImpactPath,
    historicalPdp0Exit,
    testOutcomes: outcomeRecord.testOutcomes,
    baselineSha,
  });
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
  process.stdout.write(`${JSON.stringify({ technicalPath, exitPath, phaseExit: exit.phaseExit, ownerStatusJoin: exit.ownerStatusJoin && {
    status: exit.ownerStatusJoin.status,
    predecessorPathCount: exit.ownerStatusJoin.predecessorPathCount,
    observedPathCount: exit.ownerStatusJoin.observedPathCount,
    unchangedPathCount: exit.ownerStatusJoin.unchangedPathCount,
    ownerApprovedChangedPathCount: exit.ownerStatusJoin.ownerApprovedChangedPathCount,
    unapprovedChangedPathCount: exit.ownerStatusJoin.unapprovedChangedPathCount,
    missingPathCount: exit.ownerStatusJoin.missingPathCount,
    additionalPathCount: exit.ownerStatusJoin.additionalPathCount,
  }, lifecyclePriming }, null, 2)}\n`);
  if (exit.phaseExit.status !== 'PASS') process.exitCode = 1;
}
