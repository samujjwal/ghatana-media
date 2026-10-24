#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {currentPdp0PhaseScopedSourceFingerprints, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH, validatePdp0AuditDispositions} from './check-media-pdp0-501-audit-dispositions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = 'docs/implementation/observations/media-pdp0-crosswalk-source-pin-refresh-2026-10-23-r1-predecessor.json';
const impactPath = 'docs/implementation/observations/media-pdp0-crosswalk-source-pin-refresh-2026-10-23-r1.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function createPdp0CrosswalkSourcePinSuccessor({crosswalkBytes, sourcePins = currentPdp0PhaseScopedSourceFingerprints('PXD-225')}) {
  const crosswalk = JSON.parse(crosswalkBytes.toString('utf8'));
  const coordinator = crosswalk.coordinatorReview;
  const previousPins = crosswalk.sourceBaseline?.phaseScopedSourceFingerprintsSha256;
  if (crosswalk.denominator?.expectedUniqueIds !== 501 || crosswalk.rows?.length !== 501
      || coordinator?.decisionRef !== 'PXD-225'
      || coordinator?.priorDecisionRef !== 'PXD-223'
      || coordinator?.ownerApproval !== 'NOT_CLAIMED'
      || coordinator?.independentAcceptance !== 'NOT_CLAIMED'
      || coordinator?.acceptanceEffect !== 'none'
      || !previousPins || JSON.stringify(Object.keys(previousPins).sort()) !== JSON.stringify(Object.keys(sourcePins).sort())) {
    throw new Error('PDP-0 501-row crosswalk is not the expected PXD-225 currentness predecessor');
  }
  const changedPaths = Object.keys(sourcePins).filter(ref => previousPins[ref] !== sourcePins[ref]);
  if (changedPaths.length !== 1 || changedPaths[0] !== '.product-experience/source-manifest.yaml#PDP-0-projection'
      || JSON.stringify(coordinator.sourceFingerprints) !== JSON.stringify(previousPins)
      || JSON.stringify(coordinator.phaseScopedSourceFingerprintsSha256) !== JSON.stringify(previousPins)) {
    throw new Error('PXD-225 crosswalk refresh must repair only the changed PDP-0 source-manifest projection pin');
  }
  const result = structuredClone(crosswalk);
  result.sourceBaseline.phaseScopedSourceFingerprintsSha256 = structuredClone(sourcePins);
  result.coordinatorReview.sourceFingerprints = structuredClone(sourcePins);
  result.coordinatorReview.phaseScopedSourceFingerprintsSha256 = structuredClone(sourcePins);
  if (result.rows.length !== crosswalk.rows.length
      || JSON.stringify(result.rows) !== JSON.stringify(crosswalk.rows)
      || JSON.stringify(result.coordinatorReview.reviewHistory) !== JSON.stringify(coordinator.reviewHistory)) {
    throw new Error('PXD-225 currentness refresh must preserve all 501 audit rows and immutable review history');
  }
  const nextBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
  const impact = {
    schemaVersion: 'media.pdp0.source-currentness-refresh.v1',
    recordId: 'MEDIA-PDP0-CROSSWALK-SOURCE-PIN-REFRESH-2026-10-23-R1',
    phase: 'PDP-0',
    decisionRef: '.product-experience/decision-log.md#PXD-225',
    classification: 'CURRENT_SOURCE_PIN_REFRESH_NO_ADDITIONAL_AUDIT_ROW_OR_PDP0_MEANING_CHANGE',
    authority: 'agent:/root/phase_io under explicit root-delegated Media technical-owner source-currentness authority; independent acceptance and owner approval are not claimed.',
    predecessor: {path: PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH, sha256: `sha256:${sha(crosswalkBytes)}`, snapshotPath, snapshotSha256: `sha256:${sha(crosswalkBytes)}`},
    sourceDelta: changedPaths.map(path => ({path, previousSha256: previousPins[path], currentSha256: sourcePins[path], disposition: 'PDP0_PROJECTION_CURRENTNESS_REBIND_NO_ROW_MEANING_CHANGE'})),
    preservedDenominators: {auditRows: 501, originalAuditRows: 428, thirdPassRows: 73, canonicalCapabilityLeaves: 462, currentCapabilityDefinitions: 469, currentDefinitionExtensions: 7},
    preservedReviewHistoryDecisionRefs: coordinator.reviewHistory.map(row => row.decisionRef),
    semanticRowDelta: [],
    resultingCrosswalkSha256: `sha256:${sha(nextBytes)}`,
    boundaries: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', runtimeAdmission: 'NOT_ADMITTED', implementation: 'NOT_CLAIMED', qualification: 'NOT_EVALUATED', closure: 'NOT_CLAIMED', delivery: 'NOT_CLAIMED'},
  };
  return {predecessorBytes: crosswalkBytes, nextBytes, impactBytes: Buffer.from(`${JSON.stringify(impact, null, 2)}\n`)};
}

function writeExclusive(relative, bytes) {
  fs.writeFileSync(path.join(root, relative), bytes, {flag: 'wx'});
}

function main() {
  const crosswalkPath = path.join(root, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH);
  const predecessorBytes = fs.readFileSync(crosswalkPath);
  const result = createPdp0CrosswalkSourcePinSuccessor({crosswalkBytes: predecessorBytes});
  const validation = validatePdp0AuditDispositions({crosswalk: JSON.parse(result.nextBytes.toString('utf8'))});
  if (validation.errors.length) throw new Error(`Refreshed PDP-0 crosswalk failed validation: ${validation.errors.join('; ')}`);
  writeExclusive(snapshotPath, result.predecessorBytes);
  fs.writeFileSync(crosswalkPath, result.nextBytes);
  writeExclusive(impactPath, result.impactBytes);
  process.stdout.write(`PDP-0 crosswalk currentness successor recorded: ${impactPath}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
