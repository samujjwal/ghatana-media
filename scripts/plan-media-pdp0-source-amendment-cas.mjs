#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildAudSpec002RebindCandidate} from './lib/media-pdp0-aud-spec-002-rebind-candidate.mjs';
import {planPdp0SourceAmendmentCas} from './lib/media-pdp0-source-amendment-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const refs = {
  crosswalk: `${folder}/pdp0-501-disposition-crosswalk.json`,
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`,
  decision: `${folder}/AUD-SPEC-002-source-owner-decision.v1.json`,
  peer: `${folder}/AUD-SPEC-002-source-amendment-peer-review.v1.json`,
  decisionLog: '.product-experience/decision-log.md',
  plan: `${folder}/AUD-SPEC-002-source-amendment-cas-plan.v1.json`,
};
const readBytes = ref => fs.readFileSync(path.join(root, ref));
const read = ref => readBytes(ref).toString('utf8');

export function prepareMediaPdp0SourceAmendmentCas() {
  const sourceBytes = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': readBytes(refs.capabilities),
    '.product-experience/pdp-0-product-truth/requirements.yaml': readBytes(refs.requirements),
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': readBytes(refs.crosswalk),
  };
  const auditBytes = readBytes(refs.audit);
  const rebuilt = buildAudSpec002RebindCandidate({
    crosswalkBytes: sourceBytes['docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'],
    auditBytes,
    capabilitiesBytes: sourceBytes['.product-experience/pdp-0-product-truth/capabilities.yaml'],
    requirementsBytes: sourceBytes['.product-experience/pdp-0-product-truth/requirements.yaml'],
  });
  const candidateText = read(refs.candidate);
  const candidate = JSON.parse(candidateText);
  const decisionText = fs.existsSync(path.join(root, refs.decision)) ? read(refs.decision) : null;
  const peerReviewText = fs.existsSync(path.join(root, refs.peer)) ? read(refs.peer) : null;
  const decision = decisionText ? JSON.parse(decisionText) : null;
  const peerReview = peerReviewText ? JSON.parse(peerReviewText) : null;
  const postimageBytes = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': rebuilt.capabilitiesPostimageBytes,
    '.product-experience/pdp-0-product-truth/requirements.yaml': rebuilt.requirementsPostimageBytes,
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': rebuilt.postimageBytes,
  };
  const plan = planPdp0SourceAmendmentCas({
    root, candidate, candidateText, rebuiltCandidate: rebuilt.candidate,
    sourceBytes, postimageBytes, decision, decisionText, peerReview, peerReviewText, decisionLogText: read(refs.decisionLog),
  });
  return {plan, candidate, candidateText, decisionText, peerReviewText, sourceBytes, postimageBytes, decisionLogText: read(refs.decisionLog), rebuiltCandidate: rebuilt.candidate};
}

export function planMediaPdp0SourceAmendmentCas({check = false} = {}) {
  const {plan} = prepareMediaPdp0SourceAmendmentCas();
  const outputBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const outputPath = path.join(root, refs.plan);
  if (check) {
    if (!fs.existsSync(outputPath) || !fs.readFileSync(outputPath).equals(outputBytes)) throw new Error('AUD-SPEC-002 source-amendment CAS plan is stale');
  }
  return plan;
}

/** Create a plan artifact once; existing frozen bytes are never overwritten. */
export function writeCreateOnlyPlanArtifact(outputPath, outputBytes, fsOps = fs) {
  let fd;
  try {
    fd = fsOps.openSync(outputPath, 'wx', 0o600);
    fsOps.writeFileSync(fd, outputBytes);
    fsOps.fsyncSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('plan artifact already exists; refusing to overwrite frozen bytes');
    throw error;
  } finally {
    if (fd !== undefined) fsOps.closeSync(fd);
  }
  const directoryFd = fsOps.openSync(path.dirname(outputPath), 'r');
  try { fsOps.fsyncSync(directoryFd); }
  finally { fsOps.closeSync(directoryFd); }
}

/** Create the fixed plan artifact once; existing frozen bytes are never overwritten. */
export function createMediaPdp0SourceAmendmentCasPlan() {
  const {plan} = prepareMediaPdp0SourceAmendmentCas();
  const outputBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const outputPath = path.join(root, refs.plan);
  writeCreateOnlyPlanArtifact(outputPath, outputBytes);
  return plan;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const unknown = args.filter(arg => !['--check', '--create'].includes(arg));
    if (unknown.length || (args.includes('--check') && args.includes('--create'))) {
      throw new Error('use no arguments for a read-only plan, --check to validate existing bytes, or --create for create-only first write');
    }
    const plan = args.includes('--create')
      ? createMediaPdp0SourceAmendmentCasPlan()
      : planMediaPdp0SourceAmendmentCas({check: args.includes('--check')});
    process.stdout.write(`${plan.planDisposition}: ${plan.blockers.join(', ')}\n`);
    process.stdout.write(`targets=${plan.targets.length}; canonical write=${plan.effects.canonicalWrite}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
