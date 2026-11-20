#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildPdp0AuditAqTraceability, PDP0_AUDIT_AQ_TRACEABILITY_PATH} from './check-media-pdp0-audit-aq-traceability.mjs';
import {PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH, validatePdp0AuditDispositions} from './check-media-pdp0-501-audit-dispositions.mjs';
import {buildPdp0CrosswalkCurrentnessSuccessor} from './prepare-media-pdp0-crosswalk-currentness-successor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-11-16/pdp0-audit-aq-traceability-v6-successor.candidate.v1.json';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function buildMediaPdp0AuditAqTraceabilitySuccessor({repositoryRoot = root} = {}) {
  const artifactPath = path.join(repositoryRoot, PDP0_AUDIT_AQ_TRACEABILITY_PATH);
  const preimageBytes = fs.readFileSync(artifactPath);
  const preimage = JSON.parse(preimageBytes.toString('utf8'));
  const candidate = buildPdp0AuditAqTraceability(repositoryRoot);
  const crosswalkSuccessor = buildPdp0CrosswalkCurrentnessSuccessor({repositoryRoot});
  const crosswalkValidation = validatePdp0AuditDispositions({repositoryRoot, crosswalk: crosswalkSuccessor.candidate});
  if (crosswalkValidation.errors.length || crosswalkValidation.stats?.total !== 501
      || crosswalkValidation.stats?.dispositionCounts?.BOUND_EXISTING !== 499
      || crosswalkValidation.stats?.dispositionCounts?.POST_PDP_IMPLEMENTATION_ONLY !== 2) {
    throw new Error(`Candidate crosswalk failed source validation: ${crosswalkValidation.errors.join(' | ')}`);
  }

  const oldV5 = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json';
  const newV6 = oldV5.replace('.v5.json', '.v6.json');
  const expectedPinKeys = new Set(Object.keys(preimage.sourceBaseline?.inputs ?? []));
  expectedPinKeys.delete(oldV5);
  expectedPinKeys.add(newV6);
  if (preimage.sourceBaseline?.inputs?.[oldV5] == null
      || !Object.hasOwn(candidate.sourceBaseline?.inputs ?? {}, newV6)
      || candidate.sourceBaseline.inputs[newV6] !== sha256(fs.readFileSync(path.join(repositoryRoot, newV6)))
      || candidate.sourceBaseline.inputs['.product-experience/pdp-0-product-truth/capability-leaf-review.yaml']
        !== sha256(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml')))
      || JSON.stringify([...expectedPinKeys].sort()) !== JSON.stringify(Object.keys(candidate.sourceBaseline.inputs).sort())) {
    throw new Error('Traceability candidate source baseline must rebind only the leaf-review and current v6 review pins');
  }

  if (preimage.capabilityMappings?.length !== 462 || candidate.capabilityMappings?.length !== 462
      || preimage.rows?.length !== 501 || candidate.rows?.length !== 501) {
    throw new Error('Traceability candidate must preserve all 501 rows and 462 historical capability mappings');
  }
  const changedCapabilityRefs = [];
  for (let i = 0; i < preimage.capabilityMappings.length; i++) {
    const before = preimage.capabilityMappings[i];
    const after = candidate.capabilityMappings[i];
    if (before.currentSourceReviewRef === oldV5) {
      if (after.currentSourceReviewRef !== newV6) {
        throw new Error(`The v5 to v6 source ref was not applied at ${before.capabilityId ?? i}`);
      }
      changedCapabilityRefs.push(before.capabilityId);
    } else if (before.currentSourceReviewRef !== after.currentSourceReviewRef) {
      throw new Error(`Unexpected current-source review ref change at capability mapping ${before.capabilityId ?? i}`);
    }
    const beforeRest = {...before}; delete beforeRest.currentSourceReviewRef;
    const afterRest = {...after}; delete afterRest.currentSourceReviewRef;
    if (!deepEqual(beforeRest, afterRest)) throw new Error(`Semantic capability mapping changed at ${before.capabilityId ?? i}`);
  }
  if (changedCapabilityRefs.length !== 154) throw new Error(`Expected 154 v5-sourced capability mappings, found ${changedCapabilityRefs.length}`);
  if (candidate.denominators?.sourceAuditRows !== 501
      || candidate.denominators?.canonicalCapabilityLeaves !== 462
      || candidate.denominators?.rowsOutsidePdp0DefinitionJoinAsImplementationOnly !== 2
      || candidate.denominators?.rowsWithStructuralCapabilityRequirementCaseJoin !== 499) {
    throw new Error('Traceability candidate changed the 501-row or 499/2 PDP-0 disposition denominator');
  }

  const sourceDelta = [];
  for (const ref of [
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
    oldV5,
    newV6,
  ]) {
    sourceDelta.push({sourceRef: ref, previousSha256: preimage.sourceBaseline.inputs[ref] ?? null,
      currentSha256: candidate.sourceBaseline.inputs[ref] ?? null,
      disposition: 'CURRENT_SOURCE_REVIEW_PIN_REBIND'});
  }
  const validation = validatePdp0AuditDispositions({repositoryRoot, crosswalk: crosswalkSuccessor.candidate});
  if (validation.errors.length) throw new Error(`Traceability candidate crosswalk validation failed: ${validation.errors.join(' | ')}`);

  return {
    candidate,
    preimageSha256: sha256(preimageBytes),
    candidateSha256: sha256(Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`)),
    sourceDelta,
    changedCapabilityRefs,
    crosswalkCandidateSha256: crosswalkSuccessor.candidateSha256,
    validation: {
      traceabilityRows: candidate.rows.length,
      canonicalCapabilityLeaves: candidate.denominators.canonicalCapabilityLeaves,
      currentVersionExtensionLeaves: candidate.denominators.currentVersionExtensionLeaves,
      futureVersionProposalLeaves: candidate.denominators.futureVersionProposalLeaves,
      crosswalkRows: validation.stats.total,
      boundExisting: validation.stats.dispositionCounts.BOUND_EXISTING,
      postPdpImplementationOnly: validation.stats.dispositionCounts.POST_PDP_IMPLEMENTATION_ONLY,
      errors: 0,
    },
    canonicalTraceabilityWritten: false,
    canonicalCrosswalkWritten: false,
    canonicalStatusWritten: false,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? DEFAULT_OUTPUT;
  const result = buildMediaPdp0AuditAqTraceabilitySuccessor();
  const outputPath = path.resolve(root, output);
  if (!outputPath.startsWith(root + path.sep)) throw new Error('Candidate output must remain inside the repository');
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  fs.writeFileSync(outputPath, `${JSON.stringify(result.candidate, null, 2)}\n`, {flag: 'wx'});
  process.stdout.write(`${JSON.stringify({
    output: path.relative(root, outputPath),
    preimageSha256: result.preimageSha256,
    candidateSha256: result.candidateSha256,
    sourceDelta: result.sourceDelta,
    changedCapabilityMappings: result.changedCapabilityRefs.length,
    validation: result.validation,
    canonicalTraceabilityWritten: false,
    canonicalCrosswalkWritten: false,
  }, null, 2)}\n`);
}
