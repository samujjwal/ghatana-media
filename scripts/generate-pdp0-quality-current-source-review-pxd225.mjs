import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {pdp0PhaseScopedSourcePins} from './report-media-pdp-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json';
const pxd222Path = 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd222.json';
const pxd225ReconciliationPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json';
const decisionPath = '.product-experience/decision-log.md';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const aqPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readText = file => fs.readFileSync(path.join(root, file), 'utf8');

export function buildPxd225QualityCurrentness({read = readText} = {}) {
  const predecessor = JSON.parse(read(pxd222Path));
  const reconciliation = JSON.parse(read(pxd225ReconciliationPath));
  if (predecessor.schemaVersion !== 'media.pdp0.quality-currentness-successor.v1'
      || predecessor.latestCurrentnessRefresh?.decisionRef !== '.product-experience/decision-log.md#PXD-222'
      || predecessor.latestCurrentnessRefresh?.semanticReview !== 'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW') {
    throw new Error('PXD-222 must remain the immutable PXD-216-preserving quality-currentness predecessor');
  }
  if (reconciliation.decisionRef !== '.product-experience/decision-log.md#PXD-225'
      || reconciliation.currentSource?.semanticChange !== 'REMOVED_ABSENT_ARCHIVED_CHANNEL_EVIDENCE_LOCATOR_ONLY'
      || reconciliation.authority?.ownerApproval !== 'NOT_CLAIMED'
      || reconciliation.authority?.independentAcceptance !== 'NOT_CLAIMED') {
    throw new Error('PXD-225 source reconciliation must authorize only dependent currentness refreshes');
  }
  const decisionLog = read(decisionPath);
  const latest = structuredClone(predecessor.latestCurrentnessRefresh);
  latest.decisionRef = '.product-experience/decision-log.md#PXD-225';
  latest.predecessorCurrentnessRef = {
    decisionRef: '.product-experience/decision-log.md#PXD-222',
    artifactRef: pxd222Path,
    artifactSha256: sha256(read(pxd222Path)),
  };
  latest.refreshReason = 'DEPENDENT_CURRENTNESS_REFRESH_AFTER_PXD-225_CROSSWALK_AND_AQ_SOURCE_REFRESH';
  latest.sourceFingerprints[crosswalkPath] = sha256(read(crosswalkPath));
  latest.sourceFingerprints[aqPath] = sha256(read(aqPath));
  // The PXD-225 refresh depends on current PDP-0 applicability across the
  // campaign. Bind the exact PDP-0 projection of the manifest, not only the
  // source file bytes, so new in-scope consumers cannot hide behind a stale
  // currentness record.
  latest.sourceFingerprints['.product-experience/source-manifest.yaml#PDP-0-projection'] =
    pdp0PhaseScopedSourcePins()['.product-experience/source-manifest.yaml#PDP-0-projection'];
  latest.sourceFingerprints[pxd222Path] = sha256(read(pxd222Path));
  latest.sourceFingerprints[pxd225ReconciliationPath] = sha256(read(pxd225ReconciliationPath));
  latest.sourceFingerprints[`${decisionPath}#PXD-225-section`] = fingerprintPxdDecisionSection(decisionLog, 'PXD-225').sha256;
  return {
    schemaVersion: 'media.pdp0.quality-currentness-successor.v1',
    predecessorRef: pxd222Path,
    latestCurrentnessRefresh: latest,
  };
}

function main() {
  const check = process.argv.includes('--check');
  const outputArg = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
  const output = path.resolve(root, outputArg ?? defaultOutput);
  const generated = `${JSON.stringify(buildPxd225QualityCurrentness(), null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== generated) {
      console.error(`PXD-225 quality currentness is stale: ${path.relative(root, output)}`);
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, generated);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
