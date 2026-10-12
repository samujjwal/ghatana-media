#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = 'docs/implementation/post-pdp-current-status.json';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const phases = [0, 1, 2, 3].map(n => {
  const statusPath = `docs/implementation/pdp-${n}-phase-dev-status.json`;
  const status = JSON.parse(fs.readFileSync(path.join(root, statusPath), 'utf8'));
  const staleSources = Object.entries(status.sourceShaSet ?? {}).filter(([file, digest]) => !fs.existsSync(path.join(root,file)) || sha256(file) !== digest).map(([file]) => file);
  return { phase: status.phase, developmentStatus: status.status, definitionContentCut: status.mainSha, statusRecord: statusPath, pinnedSourceCount: Object.keys(status.sourceShaSet ?? {}).length, currentSourcePinsMatch: staleSources.length === 0, staleSourceRefs: staleSources, postCutPinRefresh: status.postCutPinRefresh ?? null, verificationResultsRemainAtRecordedCut: true };
});
const view = {
  schemaVersion: 'media.post-pdp-current-status.v1',
  productId: 'media',
  sourceDefinitionCut: 'adc9aa6adb9c3ee2f79bf9b3975a2f6daa944ae8',
  asOf: '2026-10-12',
  authority: 'Derived status projection. Phase source-development status comes from the four phase status records; other dimensions remain separately owned.',
  phaseDevelopment: { status: phases.every(p => p.developmentStatus === 'DEV_COMPLETE') ? 'DEV_COMPLETE' : 'INCOMPLETE', definitionContentCut: 'adc9aa6adb9c3ee2f79bf9b3975a2f6daa944ae8', allSourcePinsCurrent: phases.every(p => p.currentSourcePinsMatch), phases },
  readinessDimensions: {
    independentAccepted: { status: 'PENDING', claim: false, basis: 'Independent PDP semantic and accessibility review is explicitly deferred in phase records; bounded Media owner decisions do not substitute for it.', sourceRefs: ['docs/implementation/pdp-0-phase-dev-status.json', 'docs/implementation/pdp-2-phase-dev-status.json', 'docs/implementation/pdp-3-phase-dev-status.json', '.product-experience/acceptance.yaml'] },
    runtimeQualified: { status: 'NOT_QUALIFIED', claim: false, basis: 'Runtime implementation, host admission, and production qualification remain deferred; definition and simulation records do not establish deployment.', sourceRefs: ['docs/implementation/pdp-1-phase-dev-status.json', 'docs/implementation/pdp-2-phase-dev-status.json', 'docs/implementation/pdp-3-phase-dev-status.json', 'README.md'] },
    LifecycleReceiptCurrent: { status: 'NOT_RECORDED', claim: false, basis: 'Lifecycle owns evidence admission, receipt issuance, and currentness; absence of a Media-local receipt reference is not a zero-receipt assertion.', sourceRefs: ['.product-experience/README.md', '.product-experience/gaps.yaml'] },
    publicContractAcceptance: { status: 'PENDING_EXTERNAL_OWNER', claim: false, basis: 'Published Shared/platform package and consumer acceptance are not established by local workspace builds.', sourceRefs: ['docs/implementation/pdp-2-phase-dev-status.json', 'docs/implementation/pdp-3-phase-dev-status.json', '.product-experience/gaps.yaml'] },
    migrationCutover: { status: 'OPEN', claim: false, basis: 'The source service remains canonical until reviewed parity and cutover admission.', sourceRefs: ['README.md', 'BOUNDARY.md', 'docs/migration/repository-preparation-status.md'] },
    productionQualified: { status: 'NOT_QUALIFIED', claim: false, basis: 'No production qualification is declared by source-development status.', sourceRefs: ['docs/implementation/pdp-3-phase-dev-status.json', 'README.md'] },
    releaseReady: { status: 'NOT_AUTHORIZED', claim: false, basis: 'No release authorization is recorded; production and commercial release remain deferred.', sourceRefs: ['docs/implementation/pdp-3-phase-dev-status.json', 'README.md'] }
  },
  historicalVerification: { reportedFullSuite: { result: 'REPORTED_PASS', tests: 1423, failures: 0, skips: 0, independentlyReproducedInThisStatusProjection: false, sourceRef: 'docs/implementation/verification' }, historicalPdp0FocusedSkipCount: 10, note: 'The PDP-0 historical focused run records documented skips. It is not the reported full-suite run.' }
};
view.targetedVerificationEvidenceRefs = ['docs/implementation/verification/post-pdp-2026-10-12.json'];
const rendered = `${JSON.stringify(view, null, 2)}\n`;
const output = path.join(root, outputPath);
const check = process.argv.includes('--check');
if (check) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== rendered) {
    console.error(`${outputPath} is stale; run node scripts/generate-media-post-pdp-status.mjs`);
    process.exitCode = 1;
  } else console.log(`${outputPath}: deterministic projection current`);
} else {
  fs.writeFileSync(output, rendered);
  console.log(`Wrote ${outputPath}`);
}
