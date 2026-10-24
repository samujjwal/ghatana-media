#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildCohort03SourceAmendmentPeer, cohort03SourceAmendmentPeerSchema, validateCohort03SourceAmendmentPeer} from './lib/media-pdp0-cohort03-source-amendment-peer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(root, ref));
const assignmentRef = '/Users/samujjwal/Development/ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-pdp0-resolution-cohort-assignments.json';
const refs = {
  proposal: `${outDir}/cohort-03-source-amendment-proposals.r1.json`,
  cohort: `${outDir}/cohort-03.r2.json`, cohortPeer: `${outDir}/cohort-03.r2.independent-peer.json`,
  cohort01: `${outDir}/cohort-01.r2.json`, cohort01Peer: `${outDir}/cohort-01.independent-peer.json`,
  residual: 'docs/implementation/observations/media-pdp0-p0-07-parent-case-residual-classification-2026-10-23.json',
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml', requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  authorityMap: '.product-experience/authority-map.yaml', phaseStatus: 'docs/implementation/pdp-0-phase-dev-status.json', assignment: assignmentRef,
};
function writeImmutable(ref, bytes) {
  const full = path.join(root, ref);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  if (fs.existsSync(full)) {
    if (!fs.readFileSync(full).equals(bytes)) throw new Error(`refusing to overwrite frozen peer artifact: ${ref}`);
    return;
  }
  const fd = fs.openSync(full, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function prepareCohort03SourceAmendmentPeer() {
  const record = buildCohort03SourceAmendmentPeer({
    proposalBytes: read(refs.proposal), cohortBytes: read(refs.cohort), cohortPeerBytes: read(refs.cohortPeer),
    cohort01Bytes: read(refs.cohort01), cohort01PeerBytes: read(refs.cohort01Peer), residualBytes: read(refs.residual),
    auditBytes: read(refs.audit), capabilityBytes: read(refs.capabilities), requirementBytes: read(refs.requirements),
    authorityMapBytes: read(refs.authorityMap), phaseStatusBytes: read(refs.phaseStatus), assignmentBytes: fs.readFileSync(assignmentRef),
  });
  validateCohort03SourceAmendmentPeer(record);
  const peerBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const schemaBytes = Buffer.from(`${JSON.stringify(cohort03SourceAmendmentPeerSchema(), null, 2)}\n`);
  return {record, peerBytes, schemaBytes};
}

export function writeCohort03SourceAmendmentPeer({check = false} = {}) {
  const {record, peerBytes, schemaBytes} = prepareCohort03SourceAmendmentPeer();
  const outputs = new Map([
    [`${outDir}/cohort-03-source-amendment-independent-peer.v1.json`, peerBytes],
    [`${outDir}/cohort-03-source-amendment-independent-peer.v1.schema.json`, schemaBytes],
  ]);
  if (check) {
    for (const [ref, bytes] of outputs) {
      const full = path.join(root, ref);
      if (!fs.existsSync(full) || !fs.readFileSync(full).equals(bytes)) throw new Error(`cohort-03 peer artifact is stale: ${ref}`);
    }
  } else {
    for (const [ref, bytes] of outputs) writeImmutable(ref, bytes);
  }
  return {record, hashes: Object.fromEntries([...outputs].map(([ref, bytes]) => [ref, sha(bytes)]))};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const {record, hashes} = writeCohort03SourceAmendmentPeer({check: process.argv.includes('--check')});
    process.stdout.write(`${JSON.stringify({reviewStatus: record.reviewStatus, dispositions: record.auditFindings.technicalDispositionCounts, hashes}, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
