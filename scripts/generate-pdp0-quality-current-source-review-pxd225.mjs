import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {pdp0PhaseScopedSourcePins} from './report-media-pdp-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const predecessorPath = 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json';
const pxd212SuccessorPath = 'docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd212-live-source.json';
const pxd213CaptionSuccessorPath = 'docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd213-live-source-successor-2026-11-16.json';
const pxd213QualitySuccessorPath = 'docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd213-pxd229-live-source-successor-2026-11-16.json';
const pxd223SuccessorPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223-live-source-successor-2026-11-16.json';
const defaultOutput = 'docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd225-live-source.json';
const pxd225ReconciliationPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json';
const decisionPath = '.product-experience/decision-log.md';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const aqPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readText = file => fs.readFileSync(path.join(root, file), 'utf8');

export function buildPxd225QualityCurrentness({read = readText} = {}) {
  const predecessor = JSON.parse(read(predecessorPath));
  const reconciliation = JSON.parse(read(pxd225ReconciliationPath));
  if (predecessor.schemaVersion !== 'media.pdp0.quality-currentness-successor.v1'
      || predecessor.latestCurrentnessRefresh?.decisionRef !== '.product-experience/decision-log.md#PXD-225'
      || predecessor.latestCurrentnessRefresh?.semanticReview !== 'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW') {
    throw new Error('The historical PXD-225 quality review must preserve the PXD-216 semantic review');
  }
  if (reconciliation.decisionRef !== '.product-experience/decision-log.md#PXD-225'
      || reconciliation.currentSource?.semanticChange !== 'REMOVED_ABSENT_ARCHIVED_CHANNEL_EVIDENCE_LOCATOR_ONLY'
      || reconciliation.authority?.ownerApproval !== 'NOT_CLAIMED'
      || reconciliation.authority?.independentAcceptance !== 'NOT_CLAIMED') {
    throw new Error('PXD-225 source reconciliation must authorize only dependent currentness refreshes');
  }
  const decisionLog = read(decisionPath);
  const latest = structuredClone(predecessor.latestCurrentnessRefresh);
  latest.predecessorCurrentnessRef = {
    decisionRef: '.product-experience/decision-log.md#PXD-225',
    artifactRef: predecessorPath,
    artifactSha256: sha256(read(predecessorPath)),
  };
  latest.refreshReason = 'CURRENTNESS_ONLY_REBIND_AFTER_PXD-225_DEPENDENCY_REFRESH';
  const projectionRef = '.product-experience/source-manifest.yaml#PDP-0-projection';
  for (const ref of Object.keys(latest.sourceFingerprints)) {
    if (ref === projectionRef) {
      latest.sourceFingerprints[ref] = pdp0PhaseScopedSourcePins()[projectionRef];
    } else if (ref.startsWith(`${decisionPath}#PXD-`)) {
      const decisionId = ref.match(/#PXD-(\d+)-section$/)?.[1];
      if (!decisionId) throw new Error(`Unsupported decision section pin: ${ref}`);
      latest.sourceFingerprints[ref] = fingerprintPxdDecisionSection(decisionLog, `PXD-${decisionId}`).sha256;
    } else {
      latest.sourceFingerprints[ref] = sha256(read(ref));
    }
  }
  latest.sourceFingerprints[pxd212SuccessorPath] = sha256(read(pxd212SuccessorPath));
  latest.sourceFingerprints[pxd213CaptionSuccessorPath] = sha256(read(pxd213CaptionSuccessorPath));
  latest.sourceFingerprints[pxd213QualitySuccessorPath] = sha256(read(pxd213QualitySuccessorPath));
  latest.sourceFingerprints[pxd223SuccessorPath] = sha256(read(pxd223SuccessorPath));
  latest.currentSourceSha256 = latest.sourceFingerprints[latest.sourceRef];
  latest.preservedSemanticReviewArtifactSha256 = latest.sourceFingerprints[
    'docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json'
  ];
  return {
    schemaVersion: 'media.pdp0.quality-currentness-successor.v1',
    predecessorRef: predecessorPath,
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
