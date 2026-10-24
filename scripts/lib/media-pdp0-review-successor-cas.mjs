import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {prepareMediaPdp0SourceAmendmentV7CasPlan} from './media-pdp0-source-amendment-v7-plan.mjs';
import {planQualityExtensionSourceAdoptionV2} from './media-pdp0-quality-extension-source-adoption-v2.mjs';
import {buildRootSelectedSourceIntegrationR7Postimages, ROOT_SELECTED_R7_TARGETS, ROOT_SELECTED_R7_ALLOWED_OPERATIONS} from './media-pdp0-root-selected-source-integration-projector-r7.mjs';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';
import {MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE} from './media-pdp0-root-selected-source-integration-r8-operation-profile.mjs';
import {MEDIA_PDP0_ROOT_SELECTED_R9_R02_PROFILE} from './media-pdp0-root-selected-source-integration-r9-r02-operation-profile.mjs';
import {prepareMediaPdp0RootSelectedSourceIntegrationR9R02ApplicationPlan} from './media-pdp0-root-selected-source-integration-r9-r02-application-plan.mjs';
import {MEDIA_PDP0_ROOT_SELECTED_R9_R07_PROFILE} from './media-pdp0-root-selected-source-integration-r9-r07-operation-profile.mjs';
import {prepareR9R07ApplicationPlan} from '../plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs';
import {R9R08_V2_PROFILE_ID,R9R08_V2_READ_SET,R9R08_V2_RECORD_REFS,R9R08_V2_WRITE_TARGETS,resolveR9R08V2TrustedActors,validateR9R08V2ApplyAdmission,validateR9R08V2SemanticPin} from './media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';
import {R9R08_V3_DELEGATION_REF,R9R08_V3_EFFECT,R9R08_V3_POLICY_REF,R9R08_V3_POLICY_SHA256,
  R9R08_V2_GUARD_BASELINE_SHA256,R9R08_V3_AGENTS_BASELINE_SHA256,R9R08_V3_PROFILE_ID,R9R08_V3_REVOCATION_REF,R9R08_V3_ROOT_DECISION_REF,
  validateR9R08V3TechnicalSourceDelegation} from './media-pdp0-root-selected-source-integration-r9-r08-v3-technical-guard.mjs';

const FIXED_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const TARGET = 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json';
const OBSERVATIONS = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23';
const SOURCE_AMENDMENT_OBSERVATIONS = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const R8_DIRECTORY = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const R9R08_DIRECTORY = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const R9R08_V2_APPLY_AUTHORIZATION_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.apply-authorization.r2.json`;
const R9R08_V2_PROFILE_REF = R9R08_V2_RECORD_REFS[2];
const R9R08_V2_MATERIAL_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.decision-section-material.r5.candidate.v1.json`;
const R9R08_V2_SEMANTIC_REVIEW_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.independent-peer.r08-semantic-review.v1.json`;
const R9R08_V2_FREEZE_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.freeze.v1.json`;
const R9R08_V3_CANDIDATE_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.successor-bundle.candidate.v1.json`;
const R9R08_V3_FREEZE_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.freeze.v1.json`;
const R9R08_V3_SEMANTIC_REVIEW_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.independent-peer.r08-semantic-review.v1.json`;
const R9R08_V3_MATERIAL_REF = `${R9R08_DIRECTORY}/media-pdp0-root-selected-source-integration-r9-r08.decision-section-material.r5.candidate.v1.json`;
const R8_PROFILE_ID = 'media.pdp0.root-selected-source-integration.r8.source-owner.v1';
const R8_REGISTRATION_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.operation-profile-registration.r1.json`;
const R8_REGISTRATION_SCHEMA_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.operation-profile-registration.schema.v1.json`;
const R8_FREEZE_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.freeze.v1.json`;
const R8_BUNDLE_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.successor-bundle.candidate.v1.json`;
const R8_VERIFICATION_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.rebuild-verification.candidate.v1.json`;
const R8_PROPOSAL_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.source-adoption-cas-proposal.candidate.v1.json`;
const R8_MAPPING_REF = `${R8_DIRECTORY}/media-pdp0-direct010-edit022-actual-root-mapping-decision-r01.json`;
const R8_LEDGER_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json`;
const R8_OPERATION_SCHEMA_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.allowed-operations.schema.candidate.v1.json`;
const R8_RETAINED_PROJECTION_REF = `${R8_DIRECTORY}/media-pdp0-231-cases-v7-consolidated-projection.v1.json`;
const R8_SOURCE_OWNER_DECISION_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.source-owner-decision.r1.json`;
const R8_ROOT_ADOPTION_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.root-adoption-decision.r1.json`;
const R8_APPLY_AUTHORIZATION_REF = `${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.apply-authorization.r1.json`;
const R8_H_THREAD_ID = '01a16a6c-d506-7a73-801a-609c602a12e9';
const R8_BASELINE_REF = `${R8_DIRECTORY}/media-pdp0-quality2target-current-source-baseline-2026-10-23.json`;
const R8_CURRENT7 = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  '.product-experience/decision-log.md',
  '.product-experience/pdp-0-product-truth/quality-policy.yaml',
]);
const R8_WRITE_TARGETS = Object.freeze([
  ROOT_SELECTED_R7_TARGETS.capabilities,
  ROOT_SELECTED_R7_TARGETS.requirements,
  ROOT_SELECTED_R7_TARGETS.leaf,
  ROOT_SELECTED_R7_TARGETS.crosswalk,
]);
const R9_PROFILE = MEDIA_PDP0_ROOT_SELECTED_R9_R02_PROFILE;
const R9_WRITE_TARGETS = R9_PROFILE.targets;
const SOURCE_AMENDMENT_TARGETS = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
]);
const SOURCE_AMENDMENT_TARGETS_V4 = Object.freeze([
  ...SOURCE_AMENDMENT_TARGETS,
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
]);
const SOURCE_AMENDMENT_TARGETS_SIX_FILE = Object.freeze([
  ...SOURCE_AMENDMENT_TARGETS_V4,
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  '.product-experience/decision-log.md',
]);
const QUALITY_TWO_TARGETS = Object.freeze([
  '.product-experience/decision-log.md',
  '.product-experience/pdp-0-product-truth/quality-policy.yaml',
]);
const QUALITY_LIFECYCLE_SOURCE_REFS = new Set([
  '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json',
  'ghatana-lifecycle:docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json',
]);
const QUALITY_V7_PREDECESSOR_TARGETS = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  '.product-experience/decision-log.md',
]);
const SOURCE_AMENDMENT_SIX_FILE_V7_PINS = Object.freeze([
  {targetRef: '.product-experience/pdp-0-product-truth/capabilities.yaml', preimageSha256: 'b688138bbdb6687a6f72b8faebbcd3fd24b4b0fcaef45131be431ab09ea3eeac', postimageSha256: 'fb5fa356c007dfe3617f0d8505247439dcfdea27d28016797ec927099fbc74d2'},
  {targetRef: '.product-experience/pdp-0-product-truth/requirements.yaml', preimageSha256: '5fcb6076223e75c4aa2680265f003713b1a9a9392411864cbdc09812e542a765', postimageSha256: '672ccce00c5ee762cbcd716d68dd474acad023199d87c9f99b6b528234912cb7'},
  {targetRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json', preimageSha256: '6eb4d5d5d593ee46c1bbb24dfeb379d936ed429d429b3d30956f166ea08c1a20', postimageSha256: '6f6eb6267083174de9716efcfd42d20357fb933696bafbea7444b28abcdef8a3'},
  {targetRef: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml', preimageSha256: 'dc50362cb65b82db9a11edcf69fa596faa7189b447433c6d0988992d1363f0ad', postimageSha256: '3b1326a1a07a62633a731ada9ea547f032aa765286ef47ec1e930e3e73664253'},
  {targetRef: '.product-experience/pdp-0-product-truth/campaign-extensions.yaml', preimageSha256: '7963e356453b3ecdc41ddc93fa969e51f48d8a95133daf72f6256bb8ea2773f6', postimageSha256: 'df94787015aea30fa148355cbb0a7c564c3acd007ea16b277f05c849534b64ed'},
  {targetRef: '.product-experience/decision-log.md', preimageSha256: '42876764d478b5a50a96f015f07069660b567cfba777f578167216d7c54f93e2', postimageSha256: 'e1f5acd296785b8f820d6b3cdc1582842e6956831d3220d354e6c4ba1a2cc60d'},
]);
const V7_SOURCE_OWNER_IDENTITY = 'agent:thread:01a169b7-6b81-71b0-89c7-19ae122dc16e';
const V7_DISTINCT_PEER_IDENTITY = 'agent:thread:01a16a35-bbcf-74d2-ac99-1ed74c29c3c9';
const V7_DECISION_SECTION_SHA256 = 'a98524f567639635b9dd5f43e53b8a60e40b2ea4f21d57ac19697098e9ef4dc8';

function within(rootPath, absolutePath) {
  const relative = path.relative(rootPath, absolutePath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function missing(error) { return error?.code === 'ENOENT'; }

function requireExactPublicInput(input, expectedKeys, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error(`${label} accepts only ${expectedKeys.join(' and ')}; caller roots, filesystem adapters, and readers are forbidden`);
  }
}

function physicalRoot(fsOps, root) {
  const resolved = path.resolve(root);
  const real = fsOps.realpathSync(resolved);
  const stat = fsOps.lstatSync(real);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('CAS repository root must resolve to a physical directory');
  return real;
}

/** Resolve a repository-relative path and reject every existing symlink component. */
function safePath(rootPath, relativePath, fsOps, {allowMissing = true, requireFile = false} = {}) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('CAS path must be a non-empty repository-relative path');
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  if (!within(rootPath, absolutePath)) throw new Error(`CAS path escapes repository root: ${relativePath}`);
  const relative = path.relative(rootPath, absolutePath);
  const parts = relative.split(path.sep);
  let current = rootPath;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fsOps.lstatSync(current); }
    catch (error) {
      if (missing(error) && allowMissing) continue;
      throw new Error(`CAS path component is missing or unreadable: ${path.relative(rootPath, current)}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`CAS path contains a symbolic link: ${path.relative(rootPath, current)}`);
    const physical = fsOps.realpathSync(current);
    if (!within(rootPath, physical)) throw new Error(`CAS physical path escapes repository root: ${path.relative(rootPath, current)}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`CAS parent path is not a directory: ${path.relative(rootPath, current)}`);
    if (index === parts.length - 1 && requireFile && !stat.isFile()) throw new Error(`CAS target is not a regular file: ${path.relative(rootPath, current)}`);
  }
  return absolutePath;
}

function ensureDirectoryTree(rootPath, directoryPath, fsOps) {
  if (directoryPath !== rootPath && !within(rootPath, directoryPath)) throw new Error('CAS directory escapes repository root');
  const relative = path.relative(rootPath, directoryPath);
  let current = rootPath;
  if (!relative) return;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fsOps.lstatSync(current); }
    catch (error) {
      if (!missing(error)) throw error;
      try {
        fsOps.mkdirSync(current, {mode: 0o700});
        syncDirectory(fsOps, rootPath, path.dirname(current));
      }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
      stat = fsOps.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`CAS directory is not a physical directory: ${path.relative(rootPath, current)}`);
    if (!within(rootPath, fsOps.realpathSync(current))) throw new Error(`CAS directory escapes repository root: ${path.relative(rootPath, current)}`);
  }
}

function modeOf(fsOps, filePath) {
  const stat = fsOps.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`CAS target is not a regular file: ${filePath}`);
  return stat.mode & 0o777;
}

function writeAndSync(fsOps, fd, value) {
  fsOps.writeFileSync(fd, value);
  fsOps.fsyncSync(fd);
}

function syncDirectory(fsOps, rootPath, directoryPath) {
  if (directoryPath === rootPath) {
    const stat = fsOps.lstatSync(rootPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('CAS root directory is not a physical directory');
  } else {
    safePath(rootPath, path.relative(rootPath, directoryPath), fsOps, {allowMissing: false});
  }
  const fd = fsOps.openSync(directoryPath, 'r');
  try { fsOps.fsyncSync(fd); }
  finally { fsOps.closeSync(fd); }
}

function createImmutableFile(fsOps, rootPath, filePath, bytes, mode = 0o600) {
  safePath(rootPath, path.relative(rootPath, filePath), fsOps);
  const fd = fsOps.openSync(filePath, 'wx', mode);
  try { writeAndSync(fsOps, fd, bytes); }
  finally { fsOps.closeSync(fd); }
  syncDirectory(fsOps, rootPath, path.dirname(filePath));
}

function writeAtomically(fsOps, rootPath, filePath, text, mode = 0o600) {
  safePath(rootPath, path.relative(rootPath, filePath), fsOps, {allowMissing: false, requireFile: true});
  const temporary = `${filePath}.tmp-${process.pid}`;
  safePath(rootPath, path.relative(rootPath, temporary), fsOps);
  const fd = fsOps.openSync(temporary, 'wx', mode);
  try { writeAndSync(fsOps, fd, text); }
  finally { fsOps.closeSync(fd); }
  safePath(rootPath, path.relative(rootPath, filePath), fsOps, {allowMissing: false, requireFile: true});
  safePath(rootPath, path.relative(rootPath, temporary), fsOps, {allowMissing: false, requireFile: true});
  fsOps.renameSync(temporary, filePath);
  syncDirectory(fsOps, rootPath, path.dirname(filePath));
}

function withOwnerLock(rootPath, lockRef, fsOps, callback) {
  const lockPath = safePath(rootPath, lockRef, fsOps);
  ensureDirectoryTree(rootPath, path.dirname(lockPath), fsOps);
  // Re-resolve after directory creation; O_EXCL makes lock creation immutable and exclusive.
  safePath(rootPath, lockRef, fsOps);
  let fd;
  try { fd = fsOps.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`CAS owner lock already exists; reconcile before retry: ${lockRef}`);
    throw error;
  }
  let workError;
  let result;
  try {
    writeAndSync(fsOps, fd, `${JSON.stringify({pid: process.pid, acquiredAt: new Date().toISOString()})}\n`);
    syncDirectory(fsOps, rootPath, path.dirname(lockPath));
    result = callback();
    return result;
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    try {
      const heldStat = fsOps.fstatSync(fd);
      fsOps.closeSync(fd);
      const lockStat = fsOps.lstatSync(lockPath);
      if (lockStat.isSymbolicLink() || lockStat.dev !== heldStat.dev || lockStat.ino !== heldStat.ino) {
        throw new Error('CAS owner lock identity changed; leave it for explicit reconciliation');
      }
      fsOps.unlinkSync(lockPath);
      syncDirectory(fsOps, rootPath, path.dirname(lockPath));
    } catch (cleanupError) {
      if (!workError) throw cleanupError;
    }
  }
}

function createTargetTemporary({fsOps, rootPath, targetPath, bytes, mode, suffix}) {
  const temporary = `${targetPath}.tmp-${suffix}-${process.pid}`;
  safePath(rootPath, path.relative(rootPath, temporary), fsOps);
  const fd = fsOps.openSync(temporary, 'wx', 0o600);
  try {
    fsOps.fchmodSync(fd, mode);
    writeAndSync(fsOps, fd, bytes);
  } finally { fsOps.closeSync(fd); }
  safePath(rootPath, path.relative(rootPath, temporary), fsOps, {allowMissing: false, requireFile: true});
  return temporary;
}

function verifyTargetPreimage({fsOps, rootPath, targetPath, expectedSha256, expectedMode, label}) {
  safePath(rootPath, path.relative(rootPath, targetPath), fsOps, {allowMissing: false, requireFile: true});
  const mode = modeOf(fsOps, targetPath);
  const actualSha256 = digest(fsOps.readFileSync(targetPath));
  if (actualSha256 !== expectedSha256 || mode !== expectedMode) {
    throw new Error(`${label} changed after the approved CAS preimage; no publication performed`);
  }
}

function publishTarget({fsOps, rootPath, targetPath, temporary, expectedSha256, expectedMode, label}) {
  // The owner lock serializes this owner path. The final read catches changes observed before rename; it is not a kernel CAS against an uncooperating writer racing after the read.
  verifyTargetPreimage({fsOps, rootPath, targetPath, expectedSha256, expectedMode, label});
  safePath(rootPath, path.relative(rootPath, targetPath), fsOps, {allowMissing: false, requireFile: true});
  safePath(rootPath, path.relative(rootPath, temporary), fsOps, {allowMissing: false, requireFile: true});
  fsOps.renameSync(temporary, targetPath);
  syncDirectory(fsOps, rootPath, path.dirname(targetPath));
}

export function commitValidatedPdp0ReviewPostimage({root, expectedTargetSha256, candidateSha256, postimageText, postimageSha256, decisionRef, decisionSectionSha256, applyAuthorizationSha256, fsOps = fs}) {
  const rootPath = physicalRoot(fsOps, root);
  const targetPath = safePath(rootPath, TARGET, fsOps, {allowMissing: false, requireFile: true});
  const journalRef = `${OBSERVATIONS}/apply-journal.json`;
  const snapshotRef = `${OBSERVATIONS}/preimages/direct-review-${expectedTargetSha256}.json`;
  const lockRef = `${OBSERVATIONS}/.direct-review-successor-cas.lock`;
  if (!/^[a-f0-9]{64}$/u.test(expectedTargetSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(candidateSha256 ?? '')
      || !/^[a-f0-9]{64}$/u.test(postimageSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(decisionSectionSha256 ?? '')
      || !/^[a-f0-9]{64}$/u.test(applyAuthorizationSha256 ?? '') || digest(postimageText) !== postimageSha256) {
    throw new Error('CAS postimage or source decision fingerprints are malformed or inconsistent');
  }
  return withOwnerLock(rootPath, lockRef, fsOps, () => {
    const journalPath = safePath(rootPath, journalRef, fsOps);
    const snapshotPath = safePath(rootPath, snapshotRef, fsOps);
    const targetText = fsOps.readFileSync(targetPath, 'utf8');
    const targetSha256 = digest(targetText);
    const targetMode = modeOf(fsOps, targetPath);
    if (fsOps.existsSync(journalPath)) {
      safePath(rootPath, journalRef, fsOps, {allowMissing: false, requireFile: true});
      const journal = JSON.parse(fsOps.readFileSync(journalPath, 'utf8'));
      if (journal.schemaVersion !== 'media.pdp0.current-source-review-apply-journal.v1'
          || journal.targetRef !== TARGET || journal.expectedTargetSha256 !== expectedTargetSha256
          || journal.candidateSha256 !== candidateSha256 || journal.postimageSha256 !== postimageSha256
          || journal.decisionRef !== decisionRef || journal.decisionSectionSha256 !== decisionSectionSha256
          || journal.applyAuthorizationSha256 !== applyAuthorizationSha256
          || journal.immutablePreimageSnapshotRef !== snapshotRef) {
        throw new Error('an existing apply journal belongs to a different attempt; automatic redispatch is forbidden');
      }
      if (targetSha256 === postimageSha256) return {state: 'POSTIMAGE_OBSERVED_AFTER_PRIOR_ATTEMPT', canonicalWrite: 'NOT_PERFORMED_BY_THIS_CALL', journalPath: path.relative(rootPath, journalPath), targetSha256};
      throw new Error(`an apply journal already exists and target is ${targetSha256 === expectedTargetSha256 ? 'still preimage' : 'neither expected preimage nor postimage'}; reconcile explicitly; no redispatch`);
    }
    if (targetSha256 !== expectedTargetSha256) throw new Error('canonical direct-review target changed since the approved CAS preimage');
    ensureDirectoryTree(rootPath, path.dirname(snapshotPath), fsOps);
    safePath(rootPath, snapshotRef, fsOps);
    if (fsOps.existsSync(snapshotPath)) {
      safePath(rootPath, snapshotRef, fsOps, {allowMissing: false, requireFile: true});
      if (digest(fsOps.readFileSync(snapshotPath, 'utf8')) !== targetSha256) throw new Error('immutable preimage snapshot path already contains different bytes');
    } else {
      createImmutableFile(fsOps, rootPath, snapshotPath, targetText, 0o600);
    }
    const journal = {
      schemaVersion: 'media.pdp0.current-source-review-apply-journal.v1', state: 'PREPARED', targetRef: TARGET,
      expectedTargetSha256: targetSha256, expectedTargetMode: targetMode,
      immutablePreimageSnapshotRef: path.relative(rootPath, snapshotPath), candidateSha256,
      postimageSha256, decisionRef, decisionSectionSha256, applyAuthorizationSha256,
    };
    ensureDirectoryTree(rootPath, path.dirname(journalPath), fsOps);
    safePath(rootPath, journalRef, fsOps);
    createImmutableFile(fsOps, rootPath, journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
    const temporary = createTargetTemporary({fsOps, rootPath, targetPath, bytes: postimageText, mode: targetMode, suffix: 'pdp0-source-review'});
    publishTarget({fsOps, rootPath, targetPath, temporary, expectedSha256: expectedTargetSha256, expectedMode: targetMode, label: 'canonical direct-review target'});
    safePath(rootPath, TARGET, fsOps, {allowMissing: false, requireFile: true});
    const exactReadback = fsOps.readFileSync(targetPath, 'utf8');
    if (digest(exactReadback) !== postimageSha256) throw new Error('canonical readback differs from the approved postimage; journal remains for reconciliation');
    journal.state = 'COMMITTED_EXACT_READBACK';
    journal.exactReadbackSha256 = digest(exactReadback);
    writeAtomically(fsOps, rootPath, journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
    return {state: journal.state, canonicalWrite: 'PERFORMED', targetRef: TARGET, targetSha256: postimageSha256, immutablePreimageSnapshotRef: journal.immutablePreimageSnapshotRef, journalPath: path.relative(rootPath, journalPath)};
  });
}

/**
 * Bounded multi-file CAS for one source-owner amendment. This intentionally
 * journals each rename: a crash can leave a partial postimage, but a later
 * invocation only observes/reconciles it and never redispatches writes.
 */
function commitSourceAmendmentTargets({rootPath, candidateSha256, decisionRef, decisionSectionSha256, applyAuthorizationSha256, targets, allowedTargetRefs, journalSchemaVersion, beforePrepare, fsOps}) {
  if (!/^[a-f0-9]{64}$/u.test(candidateSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(decisionSectionSha256 ?? '')
      || !/^[a-f0-9]{64}$/u.test(applyAuthorizationSha256 ?? '') || !Array.isArray(targets) || targets.length !== allowedTargetRefs.length) {
    throw new Error('source-amendment CAS fingerprints or exact target set are invalid');
  }
  const normalized = targets.map(target => {
    if (!target || typeof target.targetRef !== 'string' || !Buffer.isBuffer(target.preimageBytes) || !Buffer.isBuffer(target.postimageBytes)) {
      throw new Error('source-amendment CAS requires exact bounded preimage and postimage bytes');
    }
    const targetPath = safePath(rootPath, target.targetRef, fsOps, {allowMissing: false, requireFile: true});
    const expectedPreimageSha256 = digest(target.preimageBytes);
    const postimageSha256 = digest(target.postimageBytes);
    if (expectedPreimageSha256 !== target.expectedPreimageSha256 || postimageSha256 !== target.expectedPostimageSha256) {
      throw new Error(`source-amendment bytes differ from approved fingerprints for ${target.targetRef}`);
    }
    return {...target, targetPath, expectedPreimageSha256, postimageSha256};
  });
  if (JSON.stringify(normalized.map(row => row.targetRef)) !== JSON.stringify(allowedTargetRefs)) {
    throw new Error('source-amendment target set or order differs from the exact approved PDP-0 sources');
  }
  const journalRef = `${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/${candidateSha256}.json`;
  const lockRef = `${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/.canonical-source-amendment-cas.lock`;
  return withOwnerLock(rootPath, lockRef, fsOps, () => {
    const journalPath = safePath(rootPath, journalRef, fsOps);
    const targetModes = normalized.map(row => modeOf(fsOps, row.targetPath));
    const targetHashes = () => normalized.map(row => digest(fsOps.readFileSync(row.targetPath)));
    const observed = targetHashes();
    if (fsOps.existsSync(journalPath)) {
      safePath(rootPath, journalRef, fsOps, {allowMissing: false, requireFile: true});
      const journal = JSON.parse(fsOps.readFileSync(journalPath, 'utf8'));
      if (journal.schemaVersion !== journalSchemaVersion
          || journal.candidateSha256 !== candidateSha256 || journal.decisionRef !== decisionRef
          || journal.decisionSectionSha256 !== decisionSectionSha256 || journal.applyAuthorizationSha256 !== applyAuthorizationSha256
          || JSON.stringify(journal.targets.map(row => row.targetRef)) !== JSON.stringify(allowedTargetRefs)
          || journal.targets.some((row, index) => row.expectedPreimageSha256 !== normalized[index].expectedPreimageSha256
            || row.postimageSha256 !== normalized[index].postimageSha256)) {
        throw new Error('an existing source-amendment journal belongs to a different attempt; automatic redispatch is forbidden');
      }
      if (observed.every((hash, index) => hash === normalized[index].postimageSha256)) {
        return {state: 'POSTIMAGE_SET_OBSERVED_AFTER_PRIOR_ATTEMPT', canonicalWrite: 'NOT_PERFORMED_BY_THIS_CALL', journalPath: path.relative(rootPath, journalPath), targetSha256: observed};
      }
      throw new Error('a source-amendment journal already exists with a partial or uncertain target set; reconcile explicitly; no redispatch');
    }
    if (observed.some((hash, index) => hash !== normalized[index].expectedPreimageSha256)) {
      throw new Error('one or more canonical source targets changed since the approved CAS preimage');
    }
    if (beforePrepare) beforePrepare();
    const snapshots = normalized.map((row, index) => {
      const snapshotRef = `${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-preimages/${candidateSha256}/${index}-${path.basename(row.targetRef)}`;
      const snapshotPath = safePath(rootPath, snapshotRef, fsOps);
      ensureDirectoryTree(rootPath, path.dirname(snapshotPath), fsOps);
      safePath(rootPath, snapshotRef, fsOps);
      if (fsOps.existsSync(snapshotPath)) {
        safePath(rootPath, snapshotRef, fsOps, {allowMissing: false, requireFile: true});
        if (digest(fsOps.readFileSync(snapshotPath)) !== row.expectedPreimageSha256) throw new Error(`immutable source preimage snapshot differs for ${row.targetRef}`);
      } else {
        createImmutableFile(fsOps, rootPath, snapshotPath, row.preimageBytes, 0o600);
      }
      return path.relative(rootPath, snapshotPath);
    });
    ensureDirectoryTree(rootPath, path.dirname(journalPath), fsOps);
    safePath(rootPath, journalRef, fsOps);
    const journal = {
      schemaVersion: journalSchemaVersion, state: 'PREPARED', candidateSha256,
      decisionRef, decisionSectionSha256, applyAuthorizationSha256,
      targets: normalized.map((row, index) => ({targetRef: row.targetRef, expectedPreimageSha256: row.expectedPreimageSha256,
        postimageSha256: row.postimageSha256, expectedTargetMode: targetModes[index], immutablePreimageRef: snapshots[index], state: 'PENDING'})),
    };
    createImmutableFile(fsOps, rootPath, journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
    const writeJournal = () => writeAtomically(fsOps, rootPath, journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
    for (let index = 0; index < normalized.length; index += 1) {
      const row = normalized[index];
      const mode = targetModes[index];
      const temporary = createTargetTemporary({fsOps, rootPath, targetPath: row.targetPath, bytes: row.postimageBytes, mode, suffix: `pdp0-source-amendment-${index}`});
      publishTarget({fsOps, rootPath, targetPath: row.targetPath, temporary,
        expectedSha256: row.expectedPreimageSha256, expectedMode: mode, label: `source target ${row.targetRef}`});
      safePath(rootPath, row.targetRef, fsOps, {allowMissing: false, requireFile: true});
      const readback = fsOps.readFileSync(row.targetPath);
      if (digest(readback) !== row.postimageSha256) throw new Error(`exact source readback differs for ${row.targetRef}; journal remains for reconciliation`);
      journal.targets[index].state = 'COMMITTED_EXACT_READBACK';
      journal.targets[index].exactReadbackSha256 = digest(readback);
      writeJournal();
    }
    journal.state = 'COMMITTED_EXACT_READBACK';
    writeJournal();
    return {state: journal.state, canonicalWrite: 'PERFORMED', journalPath: path.relative(rootPath, journalPath), targets: journal.targets};
  });
}

function readR8Json(rootPath, ref) {
  const filePath = safePath(rootPath, ref, fs, {allowMissing: false, requireFile: true});
  const bytes = fs.readFileSync(filePath);
  try { return {bytes, value: JSON.parse(bytes.toString('utf8'))}; }
  catch (error) { throw new Error(`R8 authority artifact is invalid JSON: ${ref}: ${error.message}`); }
}

function r8Require(condition, message) {
  if (!condition) throw new Error(`R8 source-amendment CAS rejected: ${message}`);
}

function r8Sha(bytes) { return digest(bytes); }

function r8ExactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function r8ExactKeys(value, expected, label) {
  r8Require(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), `${label} has an unsupported or incomplete schema`);
}

function validateR8ReviewPins(review, {bundleSha, freeze, verificationSha, proposalSha, ledgerSha, schemaSha, baseline}) {
  r8Require(review?.reviewStatus === 'PASS' && Array.isArray(review.findings) && review.findings.length === 0,
    'source peer and H review must be clean PASS records');
  const pins = review.reviewedArtifactPins;
  const expected = {
    bundle: [path.posix.basename(R8_BUNDLE_REF), bundleSha],
    rebuildVerification: [path.posix.basename(R8_VERIFICATION_REF), verificationSha],
    sourceAdoptionCasProposal: [path.posix.basename(R8_PROPOSAL_REF), proposalSha],
    splitAllowedOperationsLedger: [path.posix.basename(R8_LEDGER_REF), ledgerSha],
    candidateAllowedOperationsSchema: [path.posix.basename(R8_OPERATION_SCHEMA_REF), schemaSha],
  };
  for (const [key, [ref, hash]] of Object.entries(expected)) {
    r8Require(pins?.[key]?.ref === ref && pins[key]?.expectedSha256 === hash
      && pins[key]?.actualSha256 === hash && pins[key]?.matches === true,
    `${key} review pin does not bind the frozen exact artifact`);
  }
  r8Require(review.preimageChecks?.count === 7 && review.preimageChecks?.allMatch === true
    && r8ExactArray(review.preimageChecks.targets?.map(row => [row.targetRef, row.expectedSha256, row.actualSha256, row.matches]),
      baseline.map(row => [row.targetRef, row.sha256, row.sha256, true])),
  'review does not verify the exact seven-source baseline');
  r8Require(review.splitPostimageChecks?.count === 4 && review.splitPostimageChecks?.allMatchBundleLedgerAndLiveBytes === true,
    'review does not verify all four exact R8 split postimages');
  const checks = review.operationAndOwnershipChecks;
  r8Require(checks?.operations === 113 && checks?.definitions === 18 && checks?.embeddedCapabilityCases === 56
    && checks?.parentCases === 58 && checks?.bindings === 19 && checks?.crosswalkPatches === 18
    && checks?.ownerAdjudicationMutations === 0 && checks?.trustReconstructionMutations === 0
    && checks?.historicalOwnerRowsPreserved === 462 && checks?.passed === true,
  'review operation counts or preserved-owner boundary differ from the frozen R8 packet');
}

function verifyR8DecisionEvidence(rootPath, record) {
  const match = /^\.product-experience\/decision-log\.md#(PXD-\d{3})$/u.exec(record?.decisionRef ?? '');
  r8Require(match && /^[a-f0-9]{64}$/u.test(record?.decisionSectionSha256 ?? ''), 'decision evidence ref or fingerprint is malformed');
  const {bytes} = readR8Json(rootPath, R8_BASELINE_REF);
  const baseline = JSON.parse(bytes.toString('utf8'));
  const decisionLogRef = '.product-experience/decision-log.md';
  const decisionLogPath = safePath(rootPath, decisionLogRef, fs, {allowMissing: false, requireFile: true});
  const decisionLog = fs.readFileSync(decisionLogPath, 'utf8');
  const section = fingerprintPxdDecisionSection(decisionLog, match[1]);
  r8Require(section.sha256 === record.decisionSectionSha256, `decision section ${match[1]} fingerprint is stale`);
  const expectedDecisionLogPin = baseline.currentTargets.find(row => row.targetRef === decisionLogRef)?.sha256;
  r8Require(expectedDecisionLogPin && r8Sha(fs.readFileSync(decisionLogPath)) === expectedDecisionLogPin,
    'decision log is not the exact frozen read-only guard preimage');
  return section;
}

function validateR8AuthorityAndProjection(rootPath, plan, targets) {
  const profile = MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE;
  const freezeFile = readR8Json(rootPath, R8_FREEZE_REF);
  const bundleFile = readR8Json(rootPath, R8_BUNDLE_REF);
  const verificationFile = readR8Json(rootPath, R8_VERIFICATION_REF);
  const proposalFile = readR8Json(rootPath, R8_PROPOSAL_REF);
  const mappingFile = readR8Json(rootPath, R8_MAPPING_REF);
  const ledgerFile = readR8Json(rootPath, profile.ledgerRef);
  const operationSchemaFile = readR8Json(rootPath, profile.candidateSchemaRef);
  const retainedFile = readR8Json(rootPath, R8_RETAINED_PROJECTION_REF);
  const baselineFile = readR8Json(rootPath, R8_BASELINE_REF);
  const registrationFile = readR8Json(rootPath, profile.registrationRef);
  const registrationSchemaFile = readR8Json(rootPath, R8_REGISTRATION_SCHEMA_REF);
  const freeze = freezeFile.value;
  const bundle = bundleFile.value;
  const verification = verificationFile.value;
  const proposal = proposalFile.value;
  const mapping = mappingFile.value;
  const ledger = ledgerFile.value;
  const baseline = baselineFile.value.currentTargets;
  const registration = registrationFile.value;
  const candidateSha = r8Sha(bundleFile.bytes);
  const freezeSha = r8Sha(freezeFile.bytes);
  const verificationSha = r8Sha(verificationFile.bytes);
  const proposalSha = r8Sha(proposalFile.bytes);
  const ledgerSha = r8Sha(ledgerFile.bytes);
  const schemaSha = r8Sha(operationSchemaFile.bytes);
  const registrationSchemaSha = r8Sha(registrationSchemaFile.bytes);
  const expectedFreezePins = [
    ['candidateBundle', R8_BUNDLE_REF, candidateSha],
    ['rebuildVerification', R8_VERIFICATION_REF, verificationSha],
    ['reviewedProposal', R8_PROPOSAL_REF, proposalSha],
    ['selectedAllowedOperations', profile.ledgerRef, ledgerSha],
    ['candidateSchema', profile.candidateSchemaRef, schemaSha],
  ];
  r8Require(freeze.freezeStatus === 'FROZEN_FOR_SOURCE_OWNER_AND_ROOT_REVIEW_ONLY', 'R8 packet is not frozen for review');
  for (const [key, ref, hash] of expectedFreezePins) {
    const row = key === 'selectedAllowedOperations' ? freeze.selectedAllowedOperations : freeze[key];
    r8Require(row?.ref === ref && row?.sha256 === hash, `freeze ${key} pin is stale or wrong-path`);
  }
  r8Require(bundle.candidateRevision === 'R8' && bundle.selectedBranch === 'split'
    && bundle.actualRootMappingDecision?.ref === R8_MAPPING_REF
    && bundle.actualRootMappingDecision?.sha256 === r8Sha(mappingFile.bytes)
    && mapping.selectedOptionId === 'B_SPLIT_BY_OPERATION_SCOPE', 'R8 bundle lineage or root-selected split branch is invalid');
  r8Require(verification.bundleRef === R8_BUNDLE_REF && verification.bundleSha256 === candidateSha
    && verification.status === 'PREPARATION_PASS_CANDIDATE_ONLY', 'R8 rebuild verification does not bind the exact frozen bundle');
  r8Require(proposal.candidate?.bundleRef === R8_BUNDLE_REF && proposal.candidate?.bundleSha256 === candidateSha
    && proposal.candidate?.selectedAllowedOperationsRef === profile.ledgerRef
    && proposal.candidate?.selectedAllowedOperationsSha256 === ledgerSha && proposal.candidate?.selectedBranch === 'split',
  'R8 proposal does not bind the frozen split bundle and operation ledger');
  r8Require(ledger.candidateSchemaStatus === 'NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED'
    && ledger.branch === 'split' && ledger.operations?.length === profile.counts.selectedOperations
    && ledger.retainedProjection?.operationCount === profile.counts.retainedProjectionOperations
    && ledger.counts?.ownerAdjudicationMutations === 0 && ledger.counts?.trustReconstructionMutations === 0,
  'candidate ledger is stale, registered in-place, wrong-branch, or has a changed operation boundary');
  r8Require(operationSchemaFile.value.$id === 'media.pdp0.root-selected-source-integration-allowed-operations.v1.candidate'
    && operationSchemaFile.value.properties?.candidateSchemaStatus?.const === 'NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED',
  'candidate operation schema is not the exact unregistered frozen schema');
  r8Require(registrationSchemaFile.value.$id === 'media.pdp0.root-selected-source-integration-r8-operation-profile-registration.v1'
    && registrationSchemaFile.value.properties?.profileId?.const === profile.profileId,
  'R8 operation-profile registration schema is invalid');

  const sourcePeerRef = freeze.independentPeer?.ref;
  r8Require(sourcePeerRef === profile.sourcePeerReviewRef && freeze.independentPeer?.sha256 === r8Sha(readR8Json(rootPath, sourcePeerRef).bytes),
    'frozen source-peer record is missing, wrong-path, or stale');
  const sourcePeerFile = readR8Json(rootPath, sourcePeerRef);
  const sourcePeer = sourcePeerFile.value;
  r8Require(sourcePeer.reviewerIdentity === '/root/source_peer' && sourcePeer.reviewStatus === 'PASS' && sourcePeer.technicalOnly === true,
    'source-peer identity or technical-only boundary is invalid');
  r8Require(sourcePeer.schemaVersion === 'media.pdp0.root-selected-source-integration-independent-peer-review.v1',
    'source-peer review schema is unsupported');
  validateR8ReviewPins(sourcePeer, {bundleSha: candidateSha, freeze, verificationSha, proposalSha, ledgerSha, schemaSha, baseline});

  const ownerFile = readR8Json(rootPath, profile.sourceOwnerDecisionRef);
  const rootFile = readR8Json(rootPath, profile.rootAdoptionDecisionRef);
  const applyFile = readR8Json(rootPath, profile.applyAuthorizationRef);
  const owner = ownerFile.value;
  const rootDecision = rootFile.value;
  const authorization = applyFile.value;
  const hReviewRef = owner.actualHReview?.reviewRef;
  r8Require(typeof hReviewRef === 'string' && hReviewRef.startsWith(`${R8_DIRECTORY}/`) && hReviewRef.endsWith('.json'),
    'source-owner decision must name an exact repository-local H review artifact');
  const hReviewFile = readR8Json(rootPath, hReviewRef);
  const hReview = hReviewFile.value;
  r8Require(hReview.schemaVersion === 'media.pdp0.root-selected-source-integration-independent-peer-review.v1',
    'H review schema is unsupported');
  r8Require(hReview.reviewerThreadId === profile.actualHReviewerThreadId && typeof hReview.reviewerIdentity === 'string'
    && hReview.reviewerIdentity.length > 0 && hReview.reviewerIdentity !== sourcePeer.reviewerIdentity,
  'H review does not identify the independently assigned H thread');
  validateR8ReviewPins(hReview, {bundleSha: candidateSha, freeze, verificationSha, proposalSha, ledgerSha, schemaSha, baseline});
  r8Require(owner.schemaVersion === 'media.pdp0.root-selected-source-integration-r8.source-owner-decision.r3.v1'
    && owner.decisionKind === 'SOURCE_OWNER_ADOPT_EXACT_PDP0_SOURCE_SUCCESSOR'
    && owner.candidateRef === R8_BUNDLE_REF && owner.candidateSha256 === candidateSha
    && owner.freezeManifestRef === R8_FREEZE_REF && owner.freezeManifestSha256 === freezeSha
    && owner.rootMappingDecisionRef === R8_MAPPING_REF && owner.rootMappingDecisionSha256 === r8Sha(mappingFile.bytes)
    && owner.subagentTechnicalCheckRef === sourcePeerRef && owner.subagentTechnicalCheckSha256 === r8Sha(sourcePeerFile.bytes)
    && owner.actualHReview?.reviewSha256 === r8Sha(hReviewFile.bytes)
    && owner.actualHReview?.reviewerIdentity === hReview.reviewerIdentity && owner.actualHReview?.reviewStatus === 'PASS'
    && owner.sourceOwner?.role === 'PDP0_SOURCE_OWNER' && typeof owner.sourceOwner.identity === 'string' && owner.sourceOwner.identity.length > 0
    && owner.disposition === 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_ADOPTION'
    && owner.authorityBoundary?.sourceOwnerAdoption === 'ADOPTED_EXACT_CANDIDATE'
    && owner.authorityBoundary?.canonicalApply === 'NOT_AUTHORIZED_BY_SOURCE_OWNER_DECISION',
  'exact source-owner adoption decision is missing, invalid, or bound to a different R8 review');
  r8ExactKeys(owner, ['schemaVersion','decisionKind','candidateRef','candidateSha256','freezeManifestRef','freezeManifestSha256',
    'rootMappingDecisionRef','rootMappingDecisionSha256','subagentTechnicalCheckRef','subagentTechnicalCheckSha256','actualHReview',
    'operationProfile','sourceBaseline','targetPostimages','decisionRef','decisionSectionSha256','sourceOwner','disposition','authorityBoundary'],
  'source-owner decision');
  const ownerProfile = owner.operationProfile;
  r8ExactKeys(ownerProfile, ['profileId','operationLedgerRef','operationLedgerSha256','operationSchemaRef','operationSchemaSha256',
    'operationKinds','ownerAdjudicationMutations','trustReconstructionMutations'], 'source-owner operation profile');
  r8Require(ownerProfile.profileId === profile.profileId && ownerProfile.operationLedgerRef === profile.ledgerRef
    && ownerProfile.operationLedgerSha256 === ledgerSha && ownerProfile.operationSchemaRef === profile.candidateSchemaRef
    && ownerProfile.operationSchemaSha256 === schemaSha && r8ExactArray(ownerProfile.operationKinds, [...ROOT_SELECTED_R7_ALLOWED_OPERATIONS])
    && ownerProfile.ownerAdjudicationMutations === 0 && ownerProfile.trustReconstructionMutations === 0,
  'source-owner decision does not adopt the exact versioned R8 operation profile');
  const ownerSection = verifyR8DecisionEvidence(rootPath, owner);
  const expectedSourceBaseline = Object.fromEntries(baseline.map(row => [row.targetRef, row.sha256]));
  const expectedPostimages = Object.fromEntries(freeze.selectedPostimages.map(row => [row.targetRef, row.sha256]));
  r8Require(JSON.stringify(canonical(owner.sourceBaseline)) === JSON.stringify(canonical(expectedSourceBaseline))
    && JSON.stringify(canonical(owner.targetPostimages)) === JSON.stringify(canonical(expectedPostimages)),
  'source-owner decision does not bind all seven preimages and four exact postimages');

  r8Require(rootDecision.schemaVersion === 'media.pdp0.root-selected-source-integration-r8.root-adoption-decision.v1'
    && rootDecision.decisionStatus === 'ADOPT_EXACT_R8_SPLIT_SOURCE_SUCCESSOR'
    && rootDecision.candidateRef === R8_BUNDLE_REF && rootDecision.candidateSha256 === candidateSha
    && rootDecision.sourceOwnerDecisionRef === profile.sourceOwnerDecisionRef
    && rootDecision.sourceOwnerDecisionSha256 === r8Sha(ownerFile.bytes)
    && rootDecision.actualHReviewRef === hReviewRef && rootDecision.actualHReviewSha256 === r8Sha(hReviewFile.bytes)
    && rootDecision.sourcePeerReviewRef === sourcePeerRef && rootDecision.sourcePeerReviewSha256 === r8Sha(sourcePeerFile.bytes)
    && rootDecision.selectedBranch === 'split' && rootDecision.rootAuthority?.role === 'ROOT_AUTHORITY'
    && typeof rootDecision.rootAuthority.identity === 'string' && rootDecision.rootAuthority.identity.length > 0
    && rootDecision.authorityBoundary?.canonicalApply === 'NOT_AUTHORIZED_BY_ROOT_ADOPTION_DECISION',
  'root adoption decision is absent, invalid, wrong-lineage, or not distinct from source-owner adoption');
  r8ExactKeys(rootDecision, ['schemaVersion','decisionStatus','candidateRef','candidateSha256','sourceOwnerDecisionRef',
    'sourceOwnerDecisionSha256','actualHReviewRef','actualHReviewSha256','sourcePeerReviewRef','sourcePeerReviewSha256',
    'selectedBranch','decisionRef','decisionSectionSha256','rootAuthority','authorityBoundary'], 'root adoption decision');
  const rootSection = verifyR8DecisionEvidence(rootPath, rootDecision);
  r8Require(owner.sourceOwner.identity !== rootDecision.rootAuthority.identity
    && rootDecision.rootAuthority.identity !== hReview.reviewerIdentity, 'source owner, root authority, and H reviewer must be distinct');

  r8Require(registration.schemaVersion === profile.schemaVersion
    && registration.registrationStatus === 'REGISTERED_FOR_EXACT_R8_SOURCE_SUCCESSOR_ONLY'
    && registration.profileId === profile.profileId
    && registration.registrationSchemaRef === R8_REGISTRATION_SCHEMA_REF && registration.registrationSchemaSha256 === registrationSchemaSha
    && registration.operationSchemaRef === profile.candidateSchemaRef && registration.operationSchemaSha256 === schemaSha
    && registration.operationLedgerRef === profile.ledgerRef && registration.operationLedgerSha256 === ledgerSha
    && registration.sourceOwnerDecisionRef === profile.sourceOwnerDecisionRef && registration.sourceOwnerDecisionSha256 === r8Sha(ownerFile.bytes)
    && registration.rootAdoptionDecisionRef === profile.rootAdoptionDecisionRef && registration.rootAdoptionDecisionSha256 === r8Sha(rootFile.bytes)
    && registration.sourceOwnerIdentity === owner.sourceOwner.identity
    && registration.rootAuthorityIdentity === rootDecision.rootAuthority.identity
    && registration.decisionRef === rootDecision.decisionRef && registration.decisionSectionSha256 === rootSection.sha256
    && registration.authorityBoundary?.canonicalApply === 'NOT_AUTHORIZED_BY_PROFILE_REGISTRATION',
  'R8 operation profile is missing or unregistered for these exact authority records');
  r8ExactKeys(registration, ['schemaVersion','registrationStatus','profileId','registrationSchemaRef','registrationSchemaSha256',
    'operationSchemaRef','operationSchemaSha256','operationLedgerRef','operationLedgerSha256','sourceOwnerDecisionRef',
    'sourceOwnerDecisionSha256','rootAdoptionDecisionRef','rootAdoptionDecisionSha256','decisionRef','decisionSectionSha256',
    'sourceOwnerIdentity','rootAuthorityIdentity','authorityBoundary'], 'profile registration');

  r8Require(authorization.schemaVersion === 'media.pdp0.root-selected-source-integration-r8.apply-authorization.v1'
    && authorization.effect === 'APPLY_EXACT_R8_SPLIT_SOURCE_SUCCESSOR'
    && authorization.candidateRef === R8_BUNDLE_REF && authorization.candidateSha256 === candidateSha
    && authorization.profileRegistrationRef === profile.registrationRef
    && authorization.profileRegistrationSha256 === r8Sha(registrationFile.bytes)
    && authorization.sourceOwnerDecisionRef === profile.sourceOwnerDecisionRef
    && authorization.sourceOwnerDecisionSha256 === r8Sha(ownerFile.bytes)
    && authorization.rootAdoptionDecisionRef === profile.rootAdoptionDecisionRef
    && authorization.rootAdoptionDecisionSha256 === r8Sha(rootFile.bytes)
    && authorization.actualHReviewRef === hReviewRef && authorization.actualHReviewSha256 === r8Sha(hReviewFile.bytes)
    && authorization.sourcePeerReviewRef === sourcePeerRef && authorization.sourcePeerReviewSha256 === r8Sha(sourcePeerFile.bytes)
    && authorization.applyAuthority?.role === 'CANONICAL_APPLY_AUTHORITY'
    && typeof authorization.applyAuthority.identity === 'string' && authorization.applyAuthority.identity.length > 0
    && ![owner.sourceOwner.identity, rootDecision.rootAuthority.identity, hReview.reviewerIdentity, sourcePeer.reviewerIdentity].includes(authorization.applyAuthority.identity)
    && authorization.authorityBoundary?.canonicalApply === 'EXACT_R8_CANONICAL_SOURCE_APPLY_AUTHORIZED',
  'distinct exact-input canonical apply authorization is absent or invalid');
  r8ExactKeys(authorization, ['schemaVersion','effect','candidateRef','candidateSha256','profileRegistrationRef',
    'profileRegistrationSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','rootAdoptionDecisionRef',
    'rootAdoptionDecisionSha256','actualHReviewRef','actualHReviewSha256','sourcePeerReviewRef','sourcePeerReviewSha256',
    'targetRows','sourceBaseline','decisionRef','decisionSectionSha256','applyAuthority','authorityBoundary'], 'apply authorization');
  const applySection = verifyR8DecisionEvidence(rootPath, authorization);
  r8Require(authorization.decisionSectionSha256 === applySection.sha256, 'apply-authorization decision evidence is stale');
  r8Require(JSON.stringify(canonical(authorization.sourceBaseline)) === JSON.stringify(canonical(expectedSourceBaseline))
    && r8ExactArray(authorization.targetRows?.map(row => [row.targetRef, row.preimageSha256, row.postimageSha256]),
      freeze.selectedPostimages.map(row => [row.targetRef, baseline.find(pin => pin.targetRef === row.targetRef)?.sha256, row.sha256])),
  'apply authorization does not bind all seven source preimages and four exact postimages');

  const profileRegistrationSha = r8Sha(registrationFile.bytes);
  r8Require(plan?.schemaVersion === 'media.pdp0.root-selected-source-integration-r8-cas-plan.v1'
    && plan.planDisposition === 'READY_FOR_EXACT_R8_FOUR_TARGET_CAS'
    && plan.profileId === profile.profileId
    && plan.profileRegistrationRef === profile.registrationRef && plan.profileRegistrationSha256 === profileRegistrationSha
    && plan.candidateRef === R8_BUNDLE_REF && plan.candidateSha256 === candidateSha
    && plan.freezeManifestRef === R8_FREEZE_REF && plan.freezeManifestSha256 === freezeSha
    && plan.sourceOwnerDecisionRef === profile.sourceOwnerDecisionRef && plan.sourceOwnerDecisionSha256 === r8Sha(ownerFile.bytes)
    && plan.rootAdoptionDecisionRef === profile.rootAdoptionDecisionRef && plan.rootAdoptionDecisionSha256 === r8Sha(rootFile.bytes)
    && plan.applyAuthorizationRef === profile.applyAuthorizationRef && plan.applyAuthorizationSha256 === r8Sha(applyFile.bytes)
    && plan.sourcePeerReviewRef === sourcePeerRef && plan.sourcePeerReviewSha256 === r8Sha(sourcePeerFile.bytes)
    && plan.actualHReviewRef === hReviewRef && plan.actualHReviewSha256 === r8Sha(hReviewFile.bytes)
    && plan.decisionRef === authorization.decisionRef && plan.decisionSectionSha256 === applySection.sha256,
  'R8 CAS plan is blocked or does not match the current exact authority chain');
  r8Require(r8ExactArray(plan.current7Preimages?.map(row => [row.targetRef, row.sha256]), baseline.map(row => [row.targetRef, row.sha256])),
    'CAS plan does not bind the exact ordered seven-source baseline');
  const expectedTargetRows = freeze.selectedPostimages.map(row => ({
    targetRef: row.targetRef,
    preimageSha256: baseline.find(pin => pin.targetRef === row.targetRef)?.sha256,
    postimageRef: row.postimageRef,
    postimageSha256: row.sha256,
  }));
  r8Require(JSON.stringify(canonical(plan.targets)) === JSON.stringify(canonical(expectedTargetRows))
    && r8ExactArray(targets?.map(row => [row.targetRef, row.expectedPreimageSha256, row.expectedPostimageSha256]),
      expectedTargetRows.map(row => [row.targetRef, row.preimageSha256, row.postimageSha256])),
  'CAS plan or byte inputs do not bind the exact fixed four-target allowlist');

  r8Require(baseline.length === 7 && JSON.stringify(baseline.map(row => row.targetRef)) === JSON.stringify(R8_CURRENT7),
    'baseline does not contain the exact seven ordered R8 source paths');
  const journalRef = `${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/${candidateSha}.json`;
  let priorJournal = null;
  const journalPath = safePath(rootPath, journalRef, fs);
  if (fs.existsSync(journalPath)) priorJournal = readR8Json(rootPath, journalRef).value;
  if (priorJournal) {
    r8Require(priorJournal.schemaVersion === 'media.pdp0.root-selected-source-integration-r8-apply-journal.v1'
      && priorJournal.candidateSha256 === candidateSha && priorJournal.decisionRef === authorization.decisionRef
      && priorJournal.decisionSectionSha256 === authorization.decisionSectionSha256
      && priorJournal.applyAuthorizationSha256 === r8Sha(applyFile.bytes)
      && r8ExactArray(priorJournal.targets?.map(row => row.targetRef), R8_WRITE_TARGETS),
    'existing R8 journal is from another or malformed attempt; reconcile explicitly');
    r8Require(priorJournal.targets.every((row,index) => row.expectedPreimageSha256 === expectedTargetRows[index].preimageSha256
      && row.postimageSha256 === expectedTargetRows[index].postimageSha256),
    'existing R8 journal target hashes differ from this exact candidate');
  }
  const sourceBytes = {};
  for (const row of baseline) {
    const targetPath = safePath(rootPath, row.targetRef, fs, {allowMissing: false, requireFile: true});
    const liveBytes = fs.readFileSync(targetPath);
    const liveSha = r8Sha(liveBytes);
    const writeIndex = R8_WRITE_TARGETS.indexOf(row.targetRef);
    if (writeIndex < 0) {
      r8Require(liveSha === row.sha256, `stale seven-source read-only guard: ${row.targetRef}`);
      continue;
    }
    const expected = expectedTargetRows[writeIndex];
    if (liveSha === expected.preimageSha256) sourceBytes[row.targetRef] = liveBytes;
    else {
      r8Require(priorJournal && liveSha === expected.postimageSha256,
        `stale seven-source preimage without an exact journal: ${row.targetRef}`);
      const snapshotRef = priorJournal.targets[writeIndex].immutablePreimageRef;
      const snapshotPath = safePath(rootPath, snapshotRef, fs, {allowMissing: false, requireFile: true});
      const snapshot = fs.readFileSync(snapshotPath);
      r8Require(r8Sha(snapshot) === expected.preimageSha256, `journal preimage snapshot is stale: ${row.targetRef}`);
      sourceBytes[row.targetRef] = snapshot;
    }
  }
  const frozenPostimages = Object.fromEntries(freeze.selectedPostimages.map(row => [row.targetRef,
    fs.readFileSync(safePath(rootPath, row.postimageRef, fs, {allowMissing: false, requireFile: true}))]));
  const replay = buildRootSelectedSourceIntegrationR7Postimages({
    baseSources: sourceBytes,
    retainedProjectionOperations: retainedFile.value.operations,
    operations: ledger.operations,
    frozenPostimages,
  });
  r8Require(replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.capabilities] === expectedTargetRows[0].postimageSha256
    && replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.requirements] === expectedTargetRows[1].postimageSha256
    && replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.leaf] === expectedTargetRows[2].postimageSha256
    && replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.crosswalk] === expectedTargetRows[3].postimageSha256
    && replay.rebuildSemanticallyMatchesFrozenPostimages === true,
  'R8 semantic replay differs from its frozen four postimages or 462-row preservation boundary');
  return {freeze, bundle, ledger, baseline, registrationFile, ownerFile, rootFile, applyFile, sourcePeerFile, hReviewFile,
    registrationSchemaSha, expectedTargetRows, candidateSha, applySection};
}

function r9Require(condition, message) {
  if (!condition) throw new Error(`R9-R02 source-amendment CAS rejected: ${message}`);
}

function r9Sha(bytes) { return digest(bytes); }

function readR9Json(rootPath, ref) {
  const filePath = safePath(rootPath, ref, fs, {allowMissing: false, requireFile: true});
  const bytes = fs.readFileSync(filePath);
  try { return {bytes, value: JSON.parse(bytes.toString('utf8'))}; }
  catch (error) { throw new Error(`R9-R02 authority artifact is invalid JSON: ${ref}: ${error.message}`); }
}

function validateR9R02AuthorityAndProjection(rootPath, plan, targets) {
  const profile = R9_PROFILE;
  const freezeFile=readR9Json(rootPath,profile.freezeRef),bundleFile=readR9Json(rootPath,profile.candidateRef);
  const verificationFile=readR9Json(rootPath,profile.verificationRef),ledgerFile=readR9Json(rootPath,profile.ledgerRef);
  const operationSchemaFile=readR9Json(rootPath,profile.operationSchemaRef),repairMapFile=readR9Json(rootPath,profile.repairMapRef);
  const retainedFile=readR9Json(rootPath,profile.retainedProjectionRef),baselineFile=readR9Json(rootPath,profile.baselineRef);
  const mappingFile=readR9Json(rootPath,profile.rootMappingRef),hFile=readR9Json(rootPath,profile.actualHReviewRef);
  const registrationSchemaFile=readR9Json(rootPath,profile.registrationSchemaRef);
  const ownerFile=readR9Json(rootPath,profile.sourceOwnerDecisionRef),rootFile=readR9Json(rootPath,profile.rootAdoptionDecisionRef);
  const registrationFile=readR9Json(rootPath,profile.registrationRef),applyFile=readR9Json(rootPath,profile.applyAuthorizationRef);
  const freeze=freezeFile.value,bundle=bundleFile.value,verification=verificationFile.value,ledger=ledgerFile.value;
  const retained=retainedFile.value,baseline=baselineFile.value.currentTargets,hReview=hFile.value;
  const owner=ownerFile.value,rootDecision=rootFile.value,registration=registrationFile.value,authorization=applyFile.value;
  const freezeSha=r8Sha(freezeFile.bytes),bundleSha=r8Sha(bundleFile.bytes),verificationSha=r8Sha(verificationFile.bytes);
  const ledgerSha=r8Sha(ledgerFile.bytes),operationSchemaSha=r8Sha(operationSchemaFile.bytes),repairMapSha=r8Sha(repairMapFile.bytes);
  const retainedSha=r8Sha(retainedFile.bytes),hSha=r8Sha(hFile.bytes),registrationSchemaSha=r8Sha(registrationSchemaFile.bytes);
  const ownerSha=r8Sha(ownerFile.bytes),rootSha=r8Sha(rootFile.bytes),registrationSha=r8Sha(registrationFile.bytes);
  const expectedFreezePins=[['candidateBundle',profile.candidateRef,bundleSha],['rebuildVerification',profile.verificationRef,verificationSha],
    ['operationLedger',profile.ledgerRef,ledgerSha],['operationSchema',profile.operationSchemaRef,operationSchemaSha],
    ['repairMap',profile.repairMapRef,repairMapSha],['retainedProjection',profile.retainedProjectionRef,retainedSha]];
  r9Require(freeze.freezeStatus==='FROZEN_FOR_ACTUAL_H_R02_REVIEW_ONLY'&&freeze.selectedBranch==='split','candidate freeze or selected branch is invalid');
  for(const [key,ref,hash] of expectedFreezePins)r9Require(freeze[key]?.ref===ref&&freeze[key]?.sha256===hash,`freeze ${key} pin is stale or wrong-path`);
  r9Require(freeze.predecessor?.ref===`${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.freeze.v1.json`
    && freeze.predecessor.sha256===r8Sha(readR9Json(rootPath,freeze.predecessor.ref).bytes), 'R8 predecessor freeze is stale');
  r9Require(bundle.status==='CANDIDATE_ONLY_NOT_REGISTERED_NOT_APPLIED'&&bundle.selectedBranch==='split'
    &&bundle.canonicalApply==='NONE'&&bundle.ownerAdjudicationMutations===0&&bundle.trustReconstructionMutations===0,
  'bundle is applied, registered in place, or crosses owner/trust boundaries');
  r9Require(verification.status==='R9_EXACT_REBUILD_PASS_CANDIDATE_ONLY'&&verification.bundleRef===profile.candidateRef
    &&verification.bundleSha256===bundleSha&&verification.ledgerRef===profile.ledgerRef&&verification.ledgerSha256===ledgerSha
    &&verification.schemaRef===profile.operationSchemaRef&&verification.schemaSha256===operationSchemaSha,
  'R9 rebuild verification does not bind the exact frozen candidate');
  r9Require(ledger.candidateSchemaStatus==='NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED'
    &&ledger.branch==='split'&&ledger.operations?.length===profile.counts.selectedOperations
    &&ledger.counts?.retainedProjectionOperations===profile.counts.retainedProjectionOperations
    &&ledger.counts?.predecessorR8Operations===profile.counts.predecessorR8Operations
    &&ledger.counts?.r9RepairOperations===profile.counts.r9RepairOperations
    &&ledger.counts?.historicalOwnerRowsPreserved===profile.counts.historicalOwnerRows
    &&ledger.counts?.ownerAdjudicationMutations===0&&ledger.counts?.trustReconstructionMutations===0,
  'R9 ledger counts, branch, or candidate-only boundary differ from the frozen profile');
  r9Require(operationSchemaFile.value.$id==='media.pdp0.root-selected-source-integration-allowed-operations.r9.v1.candidate'
    &&operationSchemaFile.value.properties?.candidateSchemaStatus?.const==='NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED',
  'R9 allowed-operation schema is not the exact frozen candidate schema');
  r9Require(mappingFile.value.selectedOptionId==='B_SPLIT_BY_OPERATION_SCOPE'
    &&bundle.rootMappingDecision?.ref===profile.rootMappingRef&&bundle.rootMappingDecision?.sha256===r8Sha(mappingFile.bytes),
  'root-selected split mapping decision is missing or stale');
  r9Require(freeze.selectedPostimages?.length===profile.counts.writeTargets
    &&JSON.stringify(freeze.selectedPostimages.map(row=>row.targetRef))===JSON.stringify([...R9_WRITE_TARGETS]),
  'R9 write-target set or order is not the fixed four-target allowlist');
  r9Require(baseline.length===profile.counts.currentSourceGuards&&JSON.stringify(baseline.map(row=>row.targetRef))===JSON.stringify([...R8_CURRENT7]),
    'R9 baseline is not the exact ordered seven-source guard set');
  const journalRef=`${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/${bundleSha}.json`;
  const journalPath=safePath(rootPath,journalRef,fs);
  const priorJournal=fs.existsSync(journalPath)?readR9Json(rootPath,journalRef).value:null;
  const journalTargets=priorJournal?.targets??[];
  if(priorJournal)r9Require(priorJournal.schemaVersion==='media.pdp0.root-selected-source-integration-r9-r02-apply-journal.v1'
    &&priorJournal.candidateSha256===bundleSha&&r8ExactArray(journalTargets.map(row=>row.targetRef),[...R9_WRITE_TARGETS])
    &&journalTargets.every((row,index)=>row.expectedPreimageSha256===baseline.find(pin=>pin.targetRef===row.targetRef)?.sha256
      &&row.postimageSha256===freeze.selectedPostimages[index]?.postimageSha256),
  'existing R9-R02 journal differs from this frozen application');
  const liveCurrent7=baseline.map(row=>({targetRef:row.targetRef,sha256:r8Sha(fs.readFileSync(safePath(rootPath,row.targetRef,fs,{allowMissing:false,requireFile:true})))}));
  r9Require(liveCurrent7.every(row=>{
    const pin=baseline.find(item=>item.targetRef===row.targetRef);
    if(row.sha256===pin.sha256)return true;
    const writeIndex=R9_WRITE_TARGETS.indexOf(row.targetRef);
    return !!priorJournal&&writeIndex>=0&&row.sha256===freeze.selectedPostimages[writeIndex]?.postimageSha256;
  }), 'one or more of the seven pinned PDP-0 sources changed outside this exact journaled application');
  r9Require(hReview.reviewStatus==='PASS_SCOPED_SOURCE_SEMANTIC_REVIEW'&&hReview.reviewer?.identity===profile.actualHReviewerThreadId
    &&hReview.reviewer?.humanOwnerAuthority===false&&hReview.findings?.length===0,
  'actual H R02 review is not a clean independent pass');
  const fullCutHReviewFile=readR9Json(rootPath,profile.fullCutHReviewRef);
  const fullCutHReview=fullCutHReviewFile.value;
  r9Require(fullCutHReview.reviewStatus==='PASS_SCOPED_SOURCE_SEMANTIC_REVIEW'
    &&fullCutHReview.reviewer?.identity===profile.fullCutHReviewerThreadId
    &&fullCutHReview.reviewer?.humanOwnerAuthority===false&&fullCutHReview.findings?.length===0
    &&fullCutHReview.sourceBaseline?.freezeRef===profile.freezeRef&&fullCutHReview.sourceBaseline?.freezeSha256===freezeSha
    &&fullCutHReview.sourceBaseline?.candidateBundleRef===profile.candidateRef&&fullCutHReview.sourceBaseline?.candidateBundleSha256===bundleSha,
  'full-cut actual H review is not a clean pass on the exact frozen R9-R02 candidate');
  const reviewed=hReview.reviewedInputs;
  for(const [key,ref,hash] of [['freezeManifest',profile.freezeRef,freezeSha],['candidateBundle',profile.candidateRef,bundleSha],
    ['selectedOperations',profile.ledgerRef,ledgerSha],['operationSchema',profile.operationSchemaRef,operationSchemaSha],
    ['repairMap',profile.repairMapRef,repairMapSha],['retainedProjection',profile.retainedProjectionRef,retainedSha]])
    r9Require(reviewed?.[key]?.ref===ref&&reviewed[key]?.sha256===hash,`actual H review ${key} pin does not match exact R9-R02 inputs`);
  r9Require(reviewed.liveSevenPreimages?.length===profile.counts.currentSourceGuards
    &&r8ExactArray(reviewed.liveSevenPreimages.map(row=>[row.targetRef,row.sha256]),baseline.map(row=>[row.targetRef,row.sha256])),
  'actual H review did not verify the exact seven current source preimages');
  r9Require(reviewed.selectedPostimages?.length===profile.counts.writeTargets
    &&r8ExactArray(reviewed.selectedPostimages.map(row=>[row.targetRef,row.postimageRef,row.postimageSha256]),freeze.selectedPostimages.map(row=>[row.targetRef,row.postimageRef,row.postimageSha256])),
  'actual H review did not verify the exact four postimages');
  r9Require(hReview.verifiedFacts?.some(row=>row.check==='R8_findings_resolved_in_candidate'&&row.status==='PASS')
    &&hReview.verifiedFacts?.some(row=>row.check==='retained_scope_and_nonmutation_boundaries'&&row.status==='PASS'),
  'actual H review did not confirm finding repair and retained-scope invariants');
  // Aggregate Discovery currentness and phase completion remain separate campaign gates.
  // This exact PDP-0 source correction is admitted by its frozen, live seven-source readset,
  // exact candidate/H inputs, and source-owner/root/profile/apply authority records below.
  const expectedTargets=freeze.selectedPostimages.map(row=>({targetRef:row.targetRef,preimageSha256:baseline.find(pin=>pin.targetRef===row.targetRef)?.sha256,
    postimageRef:row.postimageRef,postimageSha256:row.postimageSha256}));
  r9Require(JSON.stringify(canonical(plan?.targets))===JSON.stringify(canonical(expectedTargets))
    &&r8ExactArray(targets?.map(row=>[row.targetRef,row.expectedPreimageSha256,row.expectedPostimageSha256]),
      expectedTargets.map(row=>[row.targetRef,row.preimageSha256,row.postimageSha256])),
  'plan or supplied byte inputs do not bind the exact four-target allowlist');
  r9Require(plan?.profileId===profile.profileId&&plan?.candidateBundle?.ref===profile.candidateRef&&plan.candidateBundle.sha256===bundleSha
    &&plan?.freezeManifest?.ref===profile.freezeRef&&plan.freezeManifest.sha256===freezeSha
    &&plan?.actualHReview?.ref===profile.actualHReviewRef&&plan.actualHReview.sha256===hSha,
  'plan does not bind the exact frozen candidate, H review, and profile');
  if(priorJournal)r9Require(priorJournal.targets.every((row,index)=>row.expectedPreimageSha256===expectedTargets[index].preimageSha256
      &&row.postimageSha256===expectedTargets[index].postimageSha256), 'existing R9-R02 journal target hashes differ from the exact frozen source inputs');
  const expectedBundlePrefix=readR9Json(rootPath,`${R8_DIRECTORY}/media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json`).value.operations;
  r9Require(expectedBundlePrefix.length===profile.counts.predecessorR8Operations
    &&ledger.operations.slice(0,expectedBundlePrefix.length).every((row,index)=>JSON.stringify(row)===JSON.stringify(expectedBundlePrefix[index])),
  'R9 operation ledger does not conserve the exact R8 prefix');
  r9Require(retained.operations?.length===profile.counts.retainedProjectionOperations
    &&ledger.retainedProjection?.operationCount===retained.operations.length
    &&ledger.retainedProjection?.operationIdsSha256===r9Sha(Buffer.from(retained.operations.map(row=>row.operationId).join('\n')))
    &&ledger.counts?.r9DefinitionRepairs===1&&ledger.counts?.capabilityCaseRepairs===4&&ledger.counts?.parentCaseRepairs===4,
  'R9 does not preserve retained operations or exact repair-operation denominator');
  const repairOps=ledger.operations.slice(expectedBundlePrefix.length);
  r9Require(repairOps.length===profile.counts.r9RepairOperations
    &&repairOps.every(row=>['REVISE_CAPABILITY_OWNER_DEFINITION','REVISE_ACCEPTANCE_CASE_TEXT'].includes(row.kind))
    &&repairOps.filter(row=>row.kind==='REVISE_CAPABILITY_OWNER_DEFINITION').length===1
    &&repairOps.filter(row=>row.kind==='REVISE_ACCEPTANCE_CASE_TEXT'&&row.targetKind==='CAPABILITY').length===4
    &&repairOps.filter(row=>row.kind==='REVISE_ACCEPTANCE_CASE_TEXT'&&row.targetKind==='REQUIREMENT').length===4,
  'R9 repair operations exceed or differ from the exact six-kind profile');
  r9Require(verification.invariantChecks?.allParentCaseLinksAndPolarityPreserved===true
    &&verification.invariantChecks?.canonicalCapabilityIdentityOccurrences===8
    &&verification.invariantChecks?.featureDefinitionsPreserved===profile.counts.featureDefinitionsPreserved
    &&verification.invariantChecks?.editKindsCriterionPreserved===true
    &&verification.invariantChecks?.historicalOwnerRowsPreserved===profile.counts.historicalOwnerRows,
  'R9 semantic conservation and exact denominator checks failed');
  const projectedCapabilities=YAML.parse(fs.readFileSync(safePath(rootPath,freeze.selectedPostimages[0].postimageRef,fs,{allowMissing:false,requireFile:true}),'utf8'));
  const projectedRequirements=YAML.parse(fs.readFileSync(safePath(rootPath,freeze.selectedPostimages[1].postimageRef,fs,{allowMissing:false,requireFile:true}),'utf8'));
  const parentOps=ledger.operations.filter(row=>row.kind==='APPEND_REQUIREMENT_CASE');
  r9Require(parentOps.length===profile.counts.parentCases&&new Set(parentOps.map(row=>row.record?.id)).size===profile.counts.parentCases,
    'R9 parent-case operation denominator or identities changed');
  const polarityCounts={POSITIVE:0,NEGATIVE:0};
  for(const op of parentOps){
    const childCapability=projectedCapabilities.capabilities.find(row=>row.id===op.sourceCapabilityId);
    const childCase=childCapability?.acceptanceCases?.find(row=>row.id===op.sourceCapabilityCaseId);
    const parentRequirement=projectedRequirements.requirements.find(row=>row.id===op.requirementId);
    const parentCase=parentRequirement?.acceptanceCases?.find(row=>row.id===op.record.id);
    const polarity=String(op.polarity).toUpperCase();
    r9Require(childCase&&parentCase&&['POSITIVE','NEGATIVE'].includes(polarity)
      &&op.record.sourceCapabilityId===op.sourceCapabilityId&&op.record.sourceCapabilityCaseId===op.sourceCapabilityCaseId
      &&String(op.record.polarity).toUpperCase()===polarity
      &&parentCase.sourceCapabilityId===op.sourceCapabilityId&&parentCase.sourceCapabilityCaseId===op.sourceCapabilityCaseId
      &&String(parentCase.polarity).toUpperCase()===polarity&&String(childCase.polarity).toUpperCase()===polarity,
    `R9 parent link or polarity diverges for ${op.record?.id}`);
    polarityCounts[polarity]++;
  }
  const r8ParentOps=expectedBundlePrefix.filter(row=>row.kind==='APPEND_REQUIREMENT_CASE');
  r9Require(r8ParentOps.length===profile.counts.parentCases
    &&JSON.stringify(polarityCounts)===JSON.stringify(r8ParentOps.reduce((out,row)=>{out[String(row.polarity).toUpperCase()]++;return out;},{POSITIVE:0,NEGATIVE:0})),
  'R9 parent-case positive/negative denominator differs from exact R8 history');
  const linkedParentCases=parentOps.filter(op=>['MEDIA-P0-AUD-DIRECT-010-B_SPLIT_DIRECT-POS','MEDIA-P0-AUD-DIRECT-010-B_SPLIT_DIRECT-NEG',
    'MEDIA-P0-AUD-EDIT-022-B_SPLIT_EDIT-POS','MEDIA-P0-AUD-EDIT-022-B_SPLIT_EDIT-NEG'].includes(op.sourceCapabilityCaseId));
  r9Require(linkedParentCases.length===4&&linkedParentCases.every(op=>{
    const capability=projectedCapabilities.capabilities.find(row=>row.id===op.sourceCapabilityId);
    const child=capability?.acceptanceCases?.find(row=>row.id===op.sourceCapabilityCaseId);
    const requirement=projectedRequirements.requirements.find(row=>row.id===op.requirementId);
    const parent=requirement?.acceptanceCases?.find(row=>row.id===op.record.id);
    return parent&&child&&parent.when===child.when&&parent.then===child.then&&parent.polarity===child.polarity;
  }), 'the four R9 repaired parent cases do not exactly mirror their capability cases');
  const expectedSourceBaseline=Object.fromEntries(baseline.map(row=>[row.targetRef,row.sha256]));
  const expectedPostimages=Object.fromEntries(freeze.selectedPostimages.map(row=>[row.targetRef,row.postimageSha256]));
  r9Require(owner.schemaVersion==='media.pdp0.root-selected-source-integration-r9-r02.source-owner-decision.v2'
    &&owner.decisionKind==='SOURCE_OWNER_ADOPT_EXACT_PDP0_SOURCE_SUCCESSOR'&&owner.candidateRef===profile.candidateRef&&owner.candidateSha256===bundleSha
    &&owner.freezeManifestRef===profile.freezeRef&&owner.freezeManifestSha256===freezeSha
    &&owner.actualHReviewRef===profile.actualHReviewRef&&owner.actualHReviewSha256===hSha
    &&owner.fullCutHReviewRef===profile.fullCutHReviewRef&&owner.fullCutHReviewSha256===r9Sha(fullCutHReviewFile.bytes)
    &&owner.sourceOwner?.role==='PDP0_SOURCE_OWNER'&&typeof owner.sourceOwner.identity==='string'&&owner.sourceOwner.identity.length>0
    &&owner.disposition==='APPROVE_EXACT_CANDIDATE_FOR_SOURCE_ADOPTION'
    &&owner.authorityBoundary?.sourceOwnerAdoption==='ADOPTED_EXACT_CANDIDATE'
    &&owner.authorityBoundary?.canonicalApply==='NOT_AUTHORIZED_BY_SOURCE_OWNER_DECISION',
  'actual source-owner adoption record is missing or not bound to R9-R02');
  r8ExactKeys(owner,['schemaVersion','decisionKind','candidateRef','candidateSha256','freezeManifestRef','freezeManifestSha256','actualHReviewRef','actualHReviewSha256','fullCutHReviewRef','fullCutHReviewSha256','operationProfile','sourceBaseline','targetPostimages','decisionRef','decisionSectionSha256','sourceOwner','disposition','authorityBoundary'],'R9-R02 source-owner decision');
  const ownerProfile=owner.operationProfile;
  r8Require(ownerProfile.profileId===profile.profileId&&ownerProfile.operationLedgerRef===profile.ledgerRef&&ownerProfile.operationLedgerSha256===ledgerSha
    &&ownerProfile.operationSchemaRef===profile.operationSchemaRef&&ownerProfile.operationSchemaSha256===operationSchemaSha
    &&r8ExactArray(ownerProfile.operationKinds,[...profile.operationKinds])
    &&JSON.stringify(canonical(ownerProfile.counts))===JSON.stringify(canonical(profile.counts))
    &&ownerProfile.ownerAdjudicationMutations===0&&ownerProfile.trustReconstructionMutations===0,
  'source-owner decision does not adopt the exact versioned six-kind R9-R02 profile');
  const ownerSection=verifyR8DecisionEvidence(rootPath,owner);
  r9Require(JSON.stringify(canonical(owner.sourceBaseline))===JSON.stringify(canonical(expectedSourceBaseline))
    &&JSON.stringify(canonical(owner.targetPostimages))===JSON.stringify(canonical(expectedPostimages)),
  'source-owner decision does not bind all seven preimages and four postimages');
  r9Require(rootDecision.schemaVersion==='media.pdp0.root-selected-source-integration-r9-r02.root-adoption-decision.v3'
    &&rootDecision.decisionStatus==='ADOPT_EXACT_R9_R02_SPLIT_SOURCE_SUCCESSOR'&&rootDecision.candidateRef===profile.candidateRef
    &&rootDecision.candidateSha256===bundleSha&&rootDecision.freezeManifestRef===profile.freezeRef&&rootDecision.freezeManifestSha256===freezeSha
    &&rootDecision.sourceOwnerDecisionRef===profile.sourceOwnerDecisionRef&&rootDecision.sourceOwnerDecisionSha256===ownerSha
    &&rootDecision.actualHReviewRef===profile.actualHReviewRef&&rootDecision.actualHReviewSha256===hSha
    &&rootDecision.fullCutHReviewRef===profile.fullCutHReviewRef&&rootDecision.fullCutHReviewSha256===r9Sha(fullCutHReviewFile.bytes)
    &&rootDecision.selectedBranch==='split'&&rootDecision.rootAuthority?.role==='ROOT_AUTHORITY'
    &&typeof rootDecision.rootAuthority.identity==='string'&&rootDecision.rootAuthority.identity.length>0
    &&rootDecision.authorityBoundary?.canonicalApply==='NOT_AUTHORIZED_BY_ROOT_ADOPTION_DECISION',
  'actual distinct root-adoption record is missing or mismatched');
  r8ExactKeys(rootDecision,['schemaVersion','decisionStatus','candidateRef','candidateSha256','freezeManifestRef','freezeManifestSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','actualHReviewRef','actualHReviewSha256','fullCutHReviewRef','fullCutHReviewSha256','selectedBranch','rootAuthority','decisionRef','decisionSectionSha256','authorityBoundary'],'R9-R02 root adoption decision');
  const rootSection=verifyR8DecisionEvidence(rootPath,rootDecision);
  r9Require(rootDecision.decisionSectionSha256===rootSection.sha256&&ownerSection.sha256===owner.decisionSectionSha256
    &&owner.sourceOwner.identity!==rootDecision.rootAuthority.identity&&rootDecision.rootAuthority.identity!==hReview.reviewer.identity,
  'owner, root, and H identities must be distinct and their decision evidence current');
  r9Require(registrationSchemaFile.value.$id==='media.pdp0.root-selected-source-integration-r9-r02.operation-profile-registration.r2'
    &&registrationSchemaFile.value.properties?.profileId?.const===profile.profileId,
  'R9-R02 profile registration schema is missing or has a different profile identity');
  r9Require(registration.schemaVersion===profile.schemaVersion&&registration.registrationStatus==='REGISTERED_FOR_EXACT_R9_R02_SOURCE_SUCCESSOR_ONLY'
    &&registration.profileId===profile.profileId&&registration.registrationSchemaRef===profile.registrationSchemaRef
    &&registration.registrationSchemaSha256===registrationSchemaSha&&registration.operationSchemaRef===profile.operationSchemaRef
    &&registration.operationSchemaSha256===operationSchemaSha&&registration.operationLedgerRef===profile.ledgerRef
    &&registration.operationLedgerSha256===ledgerSha&&registration.sourceOwnerDecisionRef===profile.sourceOwnerDecisionRef
    &&registration.sourceOwnerDecisionSha256===ownerSha&&registration.rootAdoptionDecisionRef===profile.rootAdoptionDecisionRef
    &&registration.rootAdoptionDecisionSha256===rootSha&&registration.actualHReviewRef===profile.actualHReviewRef
    &&registration.actualHReviewSha256===hSha&&registration.fullCutHReviewRef===profile.fullCutHReviewRef
    &&registration.fullCutHReviewSha256===r9Sha(fullCutHReviewFile.bytes)&&registration.sourceOwnerIdentity===owner.sourceOwner.identity
    &&registration.rootAuthorityIdentity===rootDecision.rootAuthority.identity
    &&registration.authorityBoundary?.canonicalApply==='NOT_AUTHORIZED_BY_PROFILE_REGISTRATION',
  'actual source-authority registry does not register the exact R9-R02 profile');
  r8ExactKeys(registration,['schemaVersion','registrationStatus','profileId','registrationSchemaRef','registrationSchemaSha256','operationSchemaRef','operationSchemaSha256','operationLedgerRef','operationLedgerSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','rootAdoptionDecisionRef','rootAdoptionDecisionSha256','actualHReviewRef','actualHReviewSha256','fullCutHReviewRef','fullCutHReviewSha256','sourceOwnerIdentity','rootAuthorityIdentity','decisionRef','decisionSectionSha256','authorityBoundary'],'R9-R02 operation profile registration');
  const registrationSection=verifyR8DecisionEvidence(rootPath,registration);
  r9Require(authorization.schemaVersion==='media.pdp0.root-selected-source-integration-r9-r02.apply-authorization.v2'
    &&authorization.effect==='APPLY_EXACT_R9_R02_SPLIT_SOURCE_SUCCESSOR'&&authorization.candidateRef===profile.candidateRef
    &&authorization.candidateSha256===bundleSha&&authorization.freezeManifestRef===profile.freezeRef&&authorization.freezeManifestSha256===freezeSha
    &&authorization.profileRegistrationRef===profile.registrationRef&&authorization.profileRegistrationSha256===registrationSha
    &&authorization.sourceOwnerDecisionRef===profile.sourceOwnerDecisionRef&&authorization.sourceOwnerDecisionSha256===ownerSha
    &&authorization.rootAdoptionDecisionRef===profile.rootAdoptionDecisionRef&&authorization.rootAdoptionDecisionSha256===rootSha
    &&authorization.actualHReviewRef===profile.actualHReviewRef&&authorization.actualHReviewSha256===hSha
    &&authorization.fullCutHReviewRef===profile.fullCutHReviewRef&&authorization.fullCutHReviewSha256===r9Sha(fullCutHReviewFile.bytes)
    &&authorization.applyAuthority?.role==='CANONICAL_APPLY_AUTHORITY'&&typeof authorization.applyAuthority.identity==='string'
    &&![owner.sourceOwner.identity,rootDecision.rootAuthority.identity,hReview.reviewer.identity].includes(authorization.applyAuthority.identity)
    &&authorization.authorityBoundary?.canonicalApply==='EXACT_R9_R02_CANONICAL_SOURCE_APPLY_AUTHORIZED',
  'distinct exact-input canonical apply authorization is missing or mismatched');
  r8ExactKeys(authorization,['schemaVersion','effect','candidateRef','candidateSha256','freezeManifestRef','freezeManifestSha256','profileRegistrationRef','profileRegistrationSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','rootAdoptionDecisionRef','rootAdoptionDecisionSha256','actualHReviewRef','actualHReviewSha256','fullCutHReviewRef','fullCutHReviewSha256','targetRows','sourceBaseline','decisionRef','decisionSectionSha256','applyAuthority','authorityBoundary'],'R9-R02 apply authorization');
  const applySection=verifyR8DecisionEvidence(rootPath,authorization);
  if(priorJournal)r9Require(priorJournal.decisionRef===authorization.decisionRef
    &&priorJournal.decisionSectionSha256===authorization.decisionSectionSha256
    &&priorJournal.applyAuthorizationSha256===r9Sha(applyFile.bytes),
  'existing R9-R02 journal is not bound to the exact apply authorization and decision');
  r9Require(registration.decisionRef===rootDecision.decisionRef&&registration.decisionSectionSha256===rootSection.sha256
    &&authorization.decisionSectionSha256===applySection.sha256&&JSON.stringify(canonical(authorization.sourceBaseline))===JSON.stringify(canonical(expectedSourceBaseline))
    &&r8ExactArray(authorization.targetRows?.map(row=>[row.targetRef,row.preimageSha256,row.postimageSha256]),
      expectedTargets.map(row=>[row.targetRef,row.preimageSha256,row.postimageSha256])),
  'registration or apply authorization lacks exact decision evidence or the ordered seven/four source pins');
  const registrationSha256=registrationSha;
  const currentPlan=plan;
  r9Require(currentPlan?.schemaVersion==='media.pdp0.root-selected-source-integration-r9-r02.root-application-plan.v2'
    &&currentPlan.planDisposition==='READY_FOR_EXACT_R9_R02_FOUR_TARGET_CAS'
    &&currentPlan.profileId===profile.profileId&&currentPlan.candidateBundle?.sha256===bundleSha
    &&currentPlan.freezeManifest?.sha256===freezeSha&&currentPlan.fullCutHReview?.ref===profile.fullCutHReviewRef
    &&currentPlan.fullCutHReview?.sha256===r9Sha(fullCutHReviewFile.bytes)
    &&currentPlan.sourceOwnerDecisionSha256===ownerSha
    &&currentPlan.rootAdoptionDecisionSha256===rootSha&&currentPlan.profileRegistrationSha256===registrationSha256
    &&currentPlan.applyAuthorizationSha256===r9Sha(applyFile.bytes)&&currentPlan.actualHReview?.sha256===hSha,
  'R9-R02 CAS plan is blocked or not bound to every exact authority record');
  for(const [kind,ref] of Object.entries({owner:profile.sourceOwnerDecisionSchemaRef,root:profile.rootAdoptionDecisionSchemaRef,
    registration:profile.registrationSchemaRef,apply:profile.applyAuthorizationSchemaRef})){
    const schemaFile=readR9Json(rootPath,ref);
    r9Require(currentPlan.recordSchemas?.[kind]?.ref===ref&&currentPlan.recordSchemas[kind].sha256===r9Sha(schemaFile.bytes),
      `R9-R02 ${kind} decision schema is not the exact schema in the application plan`);
  }
  const sourceBytes=Object.fromEntries(baseline.map(row=>{
    const live=fs.readFileSync(safePath(rootPath,row.targetRef,fs,{allowMissing:false,requireFile:true}));
    if(r9Sha(live)===row.sha256)return [row.targetRef,live];
    const journalIndex=journalTargets.findIndex(entry=>entry.targetRef===row.targetRef);
    r9Require(!!priorJournal&&journalIndex>=0,'changed source preimage has no exact journal snapshot');
    const snapshot=fs.readFileSync(safePath(rootPath,journalTargets[journalIndex].immutablePreimageRef,fs,{allowMissing:false,requireFile:true}));
    r9Require(r9Sha(snapshot)===row.sha256,'immutable journal preimage snapshot does not match the frozen baseline');
    return [row.targetRef,snapshot];
  }));
  const frozenPostimages=Object.fromEntries(freeze.selectedPostimages.map(row=>[row.targetRef,fs.readFileSync(safePath(rootPath,row.postimageRef,fs,{allowMissing:false,requireFile:true}))]));
  const replay=buildRootSelectedSourceIntegrationR7Postimages({baseSources:Object.fromEntries(Object.values(ROOT_SELECTED_R7_TARGETS).map(ref=>[ref,sourceBytes[ref]])),
    retainedProjectionOperations:retained.operations,operations:ledger.operations,frozenPostimages});
  r9Require(replay.rebuildSemanticallyMatchesFrozenPostimages&&replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.capabilities]===expectedTargets[0].postimageSha256
    &&replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.requirements]===expectedTargets[1].postimageSha256
    &&replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.leaf]===expectedTargets[2].postimageSha256
    &&replay.postimageHashes[ROOT_SELECTED_R7_TARGETS.crosswalk]===expectedTargets[3].postimageSha256,
  'R9 operation replay differs from the frozen four postimages');
  r9Require(r8ExactArray(currentPlan.current7Preimages?.map(row=>[row.targetRef,row.sha256]),baseline.map(row=>[row.targetRef,row.sha256]))
    &&JSON.stringify(canonical(currentPlan.targets))===JSON.stringify(canonical(expectedTargets))
    &&r8ExactArray(targets?.map(row=>[row.targetRef,row.expectedPreimageSha256,row.expectedPostimageSha256]),expectedTargets.map(row=>[row.targetRef,row.preimageSha256,row.postimageSha256])),
  'CAS plan or supplied byte targets do not bind the exact seven guards and four write targets');
  return {freeze,bundle,ledger,baseline,hReview,owner,rootDecision,registration,authorization,expectedTargets,bundleSha,applySection};
}

/** Build a read-only exact-input plan from the fixed repository authority path. */
export function prepareMediaPdp0RootSelectedSourceIntegrationR8CasPlan() {
  const rootPath = physicalRoot(fs, FIXED_REPOSITORY_ROOT);
  try {
    const freezeFile = readR8Json(rootPath, R8_FREEZE_REF);
    const bundleFile = readR8Json(rootPath, R8_BUNDLE_REF);
    const registrationFile = readR8Json(rootPath, R8_REGISTRATION_REF);
    const ownerFile = readR8Json(rootPath, R8_SOURCE_OWNER_DECISION_REF);
    const rootFile = readR8Json(rootPath, R8_ROOT_ADOPTION_REF);
    const applyFile = readR8Json(rootPath, R8_APPLY_AUTHORIZATION_REF);
    const freeze = freezeFile.value;
    const baselineFile = readR8Json(rootPath, R8_BASELINE_REF);
    const baseline = baselineFile.value.currentTargets;
    const sourcePeerRef = freeze.independentPeer.ref;
    const sourcePeerFile = readR8Json(rootPath, sourcePeerRef);
    const hReviewRef = ownerFile.value.actualHReview.reviewRef;
    const hReviewFile = readR8Json(rootPath, hReviewRef);
    const ledgerFile = readR8Json(rootPath, MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE.ledgerRef);
    const operationSchemaFile = readR8Json(rootPath, MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE.candidateSchemaRef);
    const candidateSha = r8Sha(bundleFile.bytes);
    const plan = {
      schemaVersion: 'media.pdp0.root-selected-source-integration-r8-cas-plan.v1',
      planDisposition: 'READY_FOR_EXACT_R8_FOUR_TARGET_CAS',
      profileId: MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE.profileId,
      profileRegistrationRef: MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE.registrationRef,
      profileRegistrationSha256: r8Sha(registrationFile.bytes),
      candidateRef: R8_BUNDLE_REF,
      candidateSha256: candidateSha,
      freezeManifestRef: R8_FREEZE_REF,
      freezeManifestSha256: r8Sha(freezeFile.bytes),
      sourceOwnerDecisionRef: MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE.sourceOwnerDecisionRef,
      sourceOwnerDecisionSha256: r8Sha(ownerFile.bytes),
      rootAdoptionDecisionRef: MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE.rootAdoptionDecisionRef,
      rootAdoptionDecisionSha256: r8Sha(rootFile.bytes),
      applyAuthorizationRef: MEDIA_PDP0_ROOT_SELECTED_R8_PROFILE.applyAuthorizationRef,
      applyAuthorizationSha256: r8Sha(applyFile.bytes),
      sourcePeerReviewRef: sourcePeerRef,
      sourcePeerReviewSha256: r8Sha(sourcePeerFile.bytes),
      actualHReviewRef: hReviewRef,
      actualHReviewSha256: r8Sha(hReviewFile.bytes),
      decisionRef: applyFile.value.decisionRef,
      decisionSectionSha256: applyFile.value.decisionSectionSha256,
      current7Preimages: baseline.map(row => ({targetRef: row.targetRef, sha256: row.sha256})),
      targets: freeze.selectedPostimages.map(row => ({
        targetRef: row.targetRef,
        preimageSha256: baseline.find(pin => pin.targetRef === row.targetRef)?.sha256,
        postimageRef: row.postimageRef,
        postimageSha256: row.sha256,
      })),
      authorityBoundary: {sourceAdoption: 'EXACT_DECISION_RECORDED', rootAdoption: 'EXACT_DECISION_RECORDED',
        canonicalApply: 'EXACT_INPUT_AUTHORIZED', phaseStatusEffect: 'NONE'},
    };
    const targets = plan.targets.map(row => ({
      targetRef: row.targetRef,
      expectedPreimageSha256: row.preimageSha256,
      expectedPostimageSha256: row.postimageSha256,
      preimageBytes: fs.readFileSync(safePath(rootPath, row.targetRef, fs, {allowMissing: false, requireFile: true})),
      postimageBytes: fs.readFileSync(safePath(rootPath, row.postimageRef, fs, {allowMissing: false, requireFile: true})),
    }));
    validateR8AuthorityAndProjection(rootPath, plan, targets);
    return {plan, targets, blocked: false};
  } catch (error) {
    return {plan: {schemaVersion: 'media.pdp0.root-selected-source-integration-r8-cas-plan.v1',
      planDisposition: 'BLOCKED', blockers: [error.message], canonicalApply: 'NONE'}, targets: [], blocked: true};
  }
}

/**
 * Exact R8 split four-target writer. This is software support only until all
 * repository records are registered and authorized; all decisions are rebuilt
 * from fixed-path repository files under the existing owner CAS lock.
 */
export function commitValidatedPdp0RootSelectedSourceIntegrationR8(input = {}) {
  requireExactPublicInput(input, ['plan', 'targets'], 'R8 four-target source-amendment CAS');
  const {plan, targets} = input;
  const rootPath = physicalRoot(fs, FIXED_REPOSITORY_ROOT);
  validateR8AuthorityAndProjection(rootPath, plan, targets);
  const current = () => validateR8AuthorityAndProjection(rootPath, plan, targets);
  return commitSourceAmendmentTargets({
    rootPath,
    candidateSha256: plan.candidateSha256,
    decisionRef: plan.decisionRef,
    decisionSectionSha256: plan.decisionSectionSha256,
    applyAuthorizationSha256: plan.applyAuthorizationSha256,
    targets,
    allowedTargetRefs: R8_WRITE_TARGETS,
    journalSchemaVersion: 'media.pdp0.root-selected-source-integration-r8-apply-journal.v1',
    beforePrepare: current,
    fsOps: fs,
  });
}

function r9R07Require(condition,message){if(!condition)throw new Error(`R9-R07 source-amendment CAS rejected: ${message}`);}

function r9R07SchemaCheck(value,schema,label='record'){
  const fail=()=>{throw new Error(`R9-R07 ${label} does not satisfy its exact candidate schema`);};
  if(Object.hasOwn(schema,'const')&&JSON.stringify(canonical(value))!==JSON.stringify(canonical(schema.const)))fail();
  if(schema.enum&&!schema.enum.some(item=>JSON.stringify(canonical(item))===JSON.stringify(canonical(value))))fail();
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))fail();
    if(schema.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(schema.properties??{},key)))fail();
    if((schema.required??[]).some(key=>!Object.hasOwn(value,key)))fail();
    for(const [key,child] of Object.entries(schema.properties??{}))if(Object.hasOwn(value,key))r9R07SchemaCheck(value[key],child,`${label}.${key}`);
  }
  if(schema.type==='array'){
    if(!Array.isArray(value)||(schema.minItems!==undefined&&value.length<schema.minItems)||(schema.maxItems!==undefined&&value.length>schema.maxItems))fail();
    for(const item of value){if(schema.items?.oneOf){const matches=schema.items.oneOf.filter(choice=>{try{r9R07SchemaCheck(item,choice,label);return true;}catch{return false;}});if(matches.length!==1)fail();}else if(schema.items)r9R07SchemaCheck(item,schema.items,label);}
  }
  if(schema.type==='string'&&(typeof value!=='string'||(schema.minLength!==undefined&&value.length<schema.minLength)||(schema.pattern&&!new RegExp(schema.pattern,'u').test(value))))fail();
}

function validateR9R07AuthorityAndProjection(rootPath,plan,targets){
  const profile=MEDIA_PDP0_ROOT_SELECTED_R9_R07_PROFILE;
  const {plan:current,schemas}=prepareR9R07ApplicationPlan({persist:false});
  const comparable=value=>{const copy=structuredClone(value);delete copy.phaseDiagnostic;return copy;};
  r9R07Require(current.disposition==='READY_FOR_OWNER_DECISIONS_AND_APPLY_AUTHORIZATION'&&current.directCheckFailures.length===0,
    'exact frozen candidate, full-cut review, seven preimages, or four postimages failed a scoped guard');
  r9R07Require(current.authorityPrerequisitesPass&&current.authorityInputs.length===0,'one or more exact authority records are absent');
  r9R07Require(JSON.stringify(canonical(comparable(plan)))===JSON.stringify(canonical(comparable(current))),
    'supplied plan differs from the fixed-path R9-R07 plan');
  const refs={owner:profile.sourceOwnerDecisionRef,root:profile.rootAdoptionDecisionRef,registration:profile.registrationRef,apply:profile.applyAuthorizationRef};
  const schemaRefs={owner:profile.sourceOwnerDecisionSchemaRef,root:profile.rootAdoptionDecisionSchemaRef,registration:profile.registrationSchemaRef,apply:profile.applyAuthorizationSchemaRef};
  const files={};
  for(const [kind,ref] of Object.entries(refs))files[kind]=readR9Json(rootPath,ref);
  for(const [kind,ref] of Object.entries(schemaRefs)){
    const schemaFile=readR9Json(rootPath,ref);
    r9R07Require(JSON.stringify(canonical(schemaFile.value))===JSON.stringify(canonical(schemas[kind]))
      &&current.requiredAuthorityRecordShapes[kind].schemaSha256===r9Sha(schemaFile.bytes),`${kind} schema bytes changed from the plan`);
    r9R07SchemaCheck(files[kind].value,schemaFile.value,kind);
  }
  const owner=files.owner.value,rootDecision=files.root.value,registration=files.registration.value,authorization=files.apply.value;
  const ownerSha=r9Sha(files.owner.bytes),rootSha=r9Sha(files.root.bytes),registrationSha=r9Sha(files.registration.bytes),applySha=r9Sha(files.apply.bytes);
  const freeze=readR9Json(rootPath,profile.freezeRef).value;
  const baseline=freeze.current7Preimages;
  const postimages=freeze.selectedPostimages;
  const expectedBaseline=Object.fromEntries(baseline.map(row=>[row.targetRef,row.sha256]));
  const expectedPostimages=Object.fromEntries(postimages.map(row=>[row.targetRef,row.postimageSha256]));
  const hReview=readR9Json(rootPath,profile.actualHReviewRef).value;
  r9R07Require(owner.disposition==='APPROVE_EXACT_CANDIDATE_FOR_SOURCE_ADOPTION'
    &&owner.authorityBoundary?.sourceOwnerAdoption==='ADOPTED_EXACT_CANDIDATE'
    &&JSON.stringify(canonical(owner.sourceBaseline))===JSON.stringify(canonical(expectedBaseline))
    &&JSON.stringify(canonical(owner.targetPostimages))===JSON.stringify(canonical(expectedPostimages)),
  'source-owner record does not adopt exact seven/four pins');
  const ownerEvidence=verifyR8DecisionEvidence(rootPath,owner);
  r9R07Require(rootDecision.decisionStatus==='ADOPT_EXACT_R9_R07_SPLIT_SOURCE_SUCCESSOR'
    &&rootDecision.authorityBoundary?.rootAdoption==='ADOPTED_EXACT_CANDIDATE'
    &&rootDecision.sourceOwnerDecisionSha256===ownerSha&&rootDecision.sourceOwnerDecisionRef===profile.sourceOwnerDecisionRef
    &&rootDecision.authorityBoundary?.canonicalApply==='NOT_AUTHORIZED_BY_ROOT_ADOPTION_DECISION','root record is not bound to the exact owner record');
  const rootEvidence=verifyR8DecisionEvidence(rootPath,rootDecision);
  r9R07Require(registration.sourceOwnerDecisionSha256===ownerSha&&registration.rootAdoptionDecisionSha256===rootSha
    &&registration.sourceOwnerIdentity===owner.sourceOwner.identity&&registration.rootAuthorityIdentity===rootDecision.rootAuthority.identity
    &&registration.decisionRef===rootDecision.decisionRef&&registration.decisionSectionSha256===rootDecision.decisionSectionSha256
    &&registration.authorityBoundary?.canonicalApply==='NOT_AUTHORIZED_BY_PROFILE_REGISTRATION',
  'profile registration is not bound to exact owner and root records');
  const registrationEvidence=verifyR8DecisionEvidence(rootPath,registration);
  r9R07Require(authorization.profileRegistrationSha256===registrationSha&&authorization.sourceOwnerDecisionSha256===ownerSha
    &&authorization.rootAdoptionDecisionSha256===rootSha&&authorization.authorityBoundary?.canonicalApply==='EXACT_R9_R07_CANONICAL_SOURCE_APPLY_AUTHORIZED',
  'apply record is not bound to the exact profile, owner, and root records');
  const applyEvidence=verifyR8DecisionEvidence(rootPath,authorization);
  const actors=[owner.sourceOwner.identity,rootDecision.rootAuthority.identity,hReview.reviewer?.identity,authorization.applyAuthority.identity];
  r9R07Require(new Set(actors).size===actors.length&&ownerEvidence.sha256===owner.decisionSectionSha256
    &&rootEvidence.sha256===rootDecision.decisionSectionSha256&&registrationEvidence.sha256===registration.decisionSectionSha256
    &&applyEvidence.sha256===authorization.decisionSectionSha256,'decision evidence is stale or authority identities are not distinct');
  r9R07Require(registration.registrationStatus==='REGISTERED_FOR_EXACT_R9_R07_SOURCE_SUCCESSOR_ONLY'
    &&registration.profileId===profile.profileId&&authorization.effect==='APPLY_EXACT_R9_R07_SPLIT_SOURCE_SUCCESSOR'
    &&JSON.stringify(canonical(authorization.sourceBaseline))===JSON.stringify(canonical(expectedBaseline))
    &&JSON.stringify(canonical(authorization.targetRows))===JSON.stringify(canonical(postimages.map(row=>({targetRef:row.targetRef,
      preimageSha256:baseline.find(pin=>pin.targetRef===row.targetRef).sha256,postimageSha256:row.postimageSha256})))),
  'registration or apply authorization does not bind exact R9-R07 inputs');
  const expectedTargets=postimages.map(row=>({targetRef:row.targetRef,expectedPreimageSha256:baseline.find(pin=>pin.targetRef===row.targetRef).sha256,
    expectedPostimageSha256:row.postimageSha256}));
  r9R07Require(JSON.stringify(canonical(targets.map(({targetRef,expectedPreimageSha256,expectedPostimageSha256})=>({targetRef,expectedPreimageSha256,expectedPostimageSha256}))))
    ===JSON.stringify(canonical(expectedTargets)),'writer target bytes are outside the fixed four-target allowlist or order');
  for(const row of targets){
    r9R07Require(r9Sha(row.preimageBytes)===row.expectedPreimageSha256&&r9Sha(row.postimageBytes)===row.expectedPostimageSha256,
      `provided bytes differ from the frozen source pins for ${row.targetRef}`);
    r9R07Require(r9Sha(fs.readFileSync(safePath(rootPath,row.targetRef,fs,{allowMissing:false,requireFile:true})))===row.expectedPreimageSha256,
      `live target preimage changed for ${row.targetRef}`);
  }
  for(const pin of baseline)r9R07Require(r9Sha(fs.readFileSync(safePath(rootPath,pin.targetRef,fs,{allowMissing:false,requireFile:true})))===pin.sha256,
    `one of the seven exact source guards changed: ${pin.targetRef}`);
  return {candidateSha256:current.profile.candidateSha256,decisionRef:authorization.decisionRef,
    decisionSectionSha256:authorization.decisionSectionSha256,applyAuthorizationSha256:applySha};
}

/** Read-only exact R9-R07 CAS readiness probe; it remains blocked until all four real authority records exist. */
export function prepareMediaPdp0RootSelectedSourceIntegrationR9R07CasPlan(){
  const rootPath=physicalRoot(fs,FIXED_REPOSITORY_ROOT);
  const {plan}=prepareR9R07ApplicationPlan({persist:false});
  const targets=plan.selectedTargets.rows.map(row=>({targetRef:row.targetRef,expectedPreimageSha256:row.preimageSha256,
    expectedPostimageSha256:row.postimageSha256,preimageBytes:fs.readFileSync(safePath(rootPath,row.targetRef,fs,{allowMissing:false,requireFile:true})),
    postimageBytes:fs.readFileSync(safePath(rootPath,row.postimageRef,fs,{allowMissing:false,requireFile:true}))}));
  try{validateR9R07AuthorityAndProjection(rootPath,plan,targets);return {plan,targets,blocked:false};}
  catch(error){return {plan:{...plan,casReadiness:'BLOCKED',casBlocker:error.message,canonicalApply:'NONE'},targets:[],blocked:true};}
}

/** Fixed R9-R07 four-target CAS. It writes only after exact authority and source pins validate under the shared CAS lock. */
export function commitValidatedPdp0RootSelectedSourceIntegrationR9R07(input={}){
  requireExactPublicInput(input,['plan','targets'],'R9-R07 four-target source-amendment CAS');
  const {plan,targets}=input,rootPath=physicalRoot(fs,FIXED_REPOSITORY_ROOT);
  const validate=()=>validateR9R07AuthorityAndProjection(rootPath,plan,targets);
  const authorization=validate();
  return commitSourceAmendmentTargets({rootPath,candidateSha256:authorization.candidateSha256,decisionRef:authorization.decisionRef,
    decisionSectionSha256:authorization.decisionSectionSha256,applyAuthorizationSha256:authorization.applyAuthorizationSha256,
    targets,allowedTargetRefs:MEDIA_PDP0_ROOT_SELECTED_R9_R07_PROFILE.targets,
    journalSchemaVersion:'media.pdp0.root-selected-source-integration-r9-r07-apply-journal.v1',beforePrepare:validate,fsOps:fs});
}

function readR9R08V2Json(rootPath,ref,fsOps){
  const filePath=safePath(rootPath,ref,fsOps,{allowMissing:false,requireFile:true});
  const bytes=fsOps.readFileSync(filePath);
  let value;
  try{value=JSON.parse(bytes.toString('utf8'));}
  catch(error){throw new Error(`R9-R08 v2 authority JSON is invalid: ${ref}: ${error.message}`);}
  return {ref,bytes,value,sha256:digest(bytes)};
}

function loadR9R08V2WriterState(rootPath,fsOps){
  const recordRows=R9R08_V2_RECORD_REFS.map(ref=>readR9R08V2Json(rootPath,ref,fsOps));
  const profile=recordRows[2].value.operationProfile,authorization=recordRows[3].value;
  const material=readR9R08V2Json(rootPath,R9R08_V2_MATERIAL_REF,fsOps);
  const semanticReview=readR9R08V2Json(rootPath,R9R08_V2_SEMANTIC_REVIEW_REF,fsOps);
  const freeze=readR9R08V2Json(rootPath,R9R08_V2_FREEZE_REF,fsOps);
  const bundle=readR9R08V2Json(rootPath,authorization.candidateRef,fsOps);
  const liveReadSet=R9R08_V2_READ_SET.map(targetRef=>{
    const targetPath=safePath(rootPath,targetRef,fsOps,{allowMissing:false,requireFile:true});
    const bytes=fsOps.readFileSync(targetPath);
    return {targetRef,sha256:digest(bytes),bytes};
  });
  const decisionLogText=liveReadSet.find(row=>row.targetRef==='.product-experience/decision-log.md').bytes.toString('utf8');
  const targets=R9R08_V2_WRITE_TARGETS.map(targetRef=>{
    const row=authorization.targetRows?.find(entry=>entry.targetRef===targetRef);
    const frozen=freeze.value.selectedPostimages?.find(entry=>entry.targetRef===targetRef);
    if(!row||!frozen)throw new Error(`R9-R08 v2 fixed target or frozen postimage is missing: ${targetRef}`);
    const postimagePath=safePath(rootPath,frozen.postimageRef,fsOps,{allowMissing:false,requireFile:true});
    const preimageBytes=liveReadSet.find(entry=>entry.targetRef===targetRef).bytes,postimageBytes=fsOps.readFileSync(postimagePath);
    if(digest(postimageBytes)!==row.postimageSha256||digest(postimageBytes)!==frozen.postimageSha256)
      throw new Error(`R9-R08 v2 frozen postimage digest differs for ${targetRef}`);
    return {targetRef,expectedPreimageSha256:row.preimageSha256,expectedPostimageSha256:row.postimageSha256,preimageBytes,postimageBytes};
  });
  const fingerprints=[...recordRows,material,semanticReview,freeze,bundle,
    ...liveReadSet.map(row=>({ref:row.targetRef,sha256:row.sha256})),
    ...targets.map(row=>({ref:`frozen-postimage:${row.targetRef}`,sha256:digest(row.postimageBytes)}))]
    .map(row=>[row.ref,row.sha256]);
  return {recordRows,profile,authorization,material:material.value,semanticReview:semanticReview.value,freeze:freeze.value,
    bundle:bundle.value,bundleSha256:bundle.sha256,freezeSha256:freeze.sha256,semanticReviewSha256:semanticReview.sha256,
    liveReadSet,decisionLogText,targets,fingerprints,preflightSha256:digest(Buffer.from(JSON.stringify(fingerprints)))};
}

function validateR9R08V2WriterState(state){
  if(state.profile.profileId!==R9R08_V2_PROFILE_ID)throw new Error('R9-R08 v2 profile id differs from the fixed writer profile');
  const liveReadSet=state.liveReadSet.map(({targetRef,sha256})=>({targetRef,sha256}));
  // The fixed authority resolver/checker owns admission. These fields are only
  // source-record identity claims; no credentials are constructed here.
  const actorTrust=resolveR9R08V2TrustedActors(state.recordRows);
  const admission=validateR9R08V2ApplyAdmission({authorization:state.authorization,profile:state.profile,
    records:state.recordRows,actorTrust,liveReadSet,material:state.material,decisionLogText:state.decisionLogText});
  const recordDigests=state.recordRows.map(row=>row.sha256);
  if(state.authorization.candidateSha256!==state.recordRows[0].value.candidateSha256
    ||state.authorization.freezeSha256!==state.recordRows[0].value.freezeSha256
    ||state.bundleSha256!==state.authorization.candidateSha256
    ||state.freezeSha256!==state.authorization.freezeSha256
    ||state.semanticReviewSha256!==state.authorization.semanticReviewSha256
    ||state.freeze.candidateBundle?.sha256!==state.authorization.candidateSha256
    ||state.bundle.candidateRevision!=='R9-R08'
    ||state.semanticReview.reviewStatus!=='PASS_FOR_SELECTED_CANDIDATE_SEMANTICS_ONLY_BLOCKED_FOR_CURRENTNESS_AND_AUTHORITY_CHAIN'
    ||recordDigests[0]!==state.authorization.sourceOwnerDecisionSha256
    ||recordDigests[1]!==state.authorization.rootAdoptionDecisionSha256
    ||recordDigests[2]!==state.authorization.profileRegistrationSha256
    ||state.semanticReview.semanticDisposition?.status!=='PASS_FOR_FROZEN_R9_R08_SELECTED_CUT_ONLY')
    throw new Error('R9-R08 v2 bundle, freeze, peer review, or ordered authority record pins differ');
  return admission;
}

/**
 * Fixed R9-R08 v2 writer. It cannot accept caller-selected roots, paths,
 * targets, readers, actor claims, or filesystem operations. All exact records and seven read-set
 * members are reloaded and fully revalidated under the shared lease in
 * beforePrepare, before snapshots or a journal are created.
 */
export function commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2(input={}){
  requireExactPublicInput(input,[],'R9-R08 v2 four-target source-amendment CAS');
  const rootPath=physicalRoot(fs,FIXED_REPOSITORY_ROOT);
  const preflight=loadR9R08V2WriterState(rootPath,fs);
  const authorization=preflight.authorization;
  const expectedPreflightSha256=preflight.preflightSha256;
  const validateUnderLease=()=>{
    const current=loadR9R08V2WriterState(rootPath,fs);
    if(current.preflightSha256!==expectedPreflightSha256)
      throw new Error('R9-R08 v2 authority, semantic pin, whole-log CAS, or seven-file read set changed after preflight; no snapshots or writes');
    return validateR9R08V2WriterState(current);
  };
  const applyAuthorizationSha256=preflight.recordRows[3].sha256;
  let result;
  try{
    result=commitSourceAmendmentTargets({rootPath,candidateSha256:authorization.candidateSha256,
      decisionRef:authorization.decisionRef,decisionSectionSha256:authorization.decisionSectionSha256,
      applyAuthorizationSha256,targets:preflight.targets,allowedTargetRefs:R9R08_V2_WRITE_TARGETS,
      journalSchemaVersion:'media.pdp0.root-selected-source-integration-r9-r08-v2-apply-journal.v1',
      beforePrepare:validateUnderLease,fsOps:fs});
  }catch(error){
    const journalRef=`${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/${authorization.candidateSha256}.json`;
    let journalExists=false;
    try{journalExists=fs.existsSync(safePath(rootPath,journalRef,fs));}catch{}
    if(journalExists){
      let priorJournalState='UNREADABLE_REQUIRES_RECONCILIATION';
      try{priorJournalState=JSON.parse(fs.readFileSync(safePath(rootPath,journalRef,fs,{allowMissing:false,requireFile:true}),'utf8')).state??priorJournalState;}catch{}
      let observedTargets=[];
      try{observedTargets=R9R08_V2_WRITE_TARGETS.map(targetRef=>{
        const sha256=digest(fs.readFileSync(safePath(rootPath,targetRef,fs,{allowMissing:false,requireFile:true})));
        const expected=authorization.targetRows.find(row=>row.targetRef===targetRef);
        const state=sha256===expected?.preimageSha256?'PREIMAGE_OBSERVED':sha256===expected?.postimageSha256?'POSTIMAGE_OBSERVED':'OTHER_HASH_REQUIRES_RECONCILIATION';
        return {targetRef,sha256,state};
      });}
      catch{observedTargets=R9R08_V2_WRITE_TARGETS.map(targetRef=>({targetRef,status:'UNREADABLE_REQUIRES_RECONCILIATION'}));}
      error.effectState='UNKNOWN_PARTIAL_EFFECTS_REQUIRES_EXPLICIT_RECONCILIATION';
      error.journalRef=journalRef;
      error.journalState=priorJournalState;
      error.observedTargets=observedTargets;
      error.message=`${error.message}; ${error.effectState}; journal=${journalRef}; state=${priorJournalState}`;
    }else{
      error.effectState='NO_NEW_TARGET_EFFECTS_BY_THIS_ATTEMPT';
      error.message=`${error.message}; ${error.effectState}`;
    }
    throw error;
  }
  return {...result,preflightSha256:expectedPreflightSha256,readSetVersion:authorization.readSetVersion,
    canonicalApply:result.canonicalWrite==='PERFORMED'?'EXACT_R9_R08_CANONICAL_SOURCE_APPLY_PERFORMED':'NONE'};
}

function readR9R08V3Json(rootPath,ref,fsOps){
  const filePath=safePath(rootPath,ref,fsOps,{allowMissing:false,requireFile:true});
  const bytes=fsOps.readFileSync(filePath);
  let value;
  try{value=JSON.parse(bytes.toString('utf8'));}
  catch(error){throw new Error(`R9-R08 v3 technical source artifact is invalid JSON: ${ref}: ${error.message}`);}
  return {ref,bytes,value,sha256:digest(bytes)};
}

function loadR9R08V3TechnicalSourceState(rootPath,fsOps){
  const delegation=readR9R08V3Json(rootPath,R9R08_V3_DELEGATION_REF,fsOps);
  const policy=readR9R08V3Json(rootPath,R9R08_V3_POLICY_REF,fsOps);
  const rootDecisionPath=path.resolve(rootPath,R9R08_V3_ROOT_DECISION_REF);
  const rootDecisionBytes=fsOps.readFileSync(rootDecisionPath);
  const rootDecision={value:JSON.parse(rootDecisionBytes.toString('utf8')),bytes:rootDecisionBytes,sha256:digest(rootDecisionBytes)};
  const agentsSha256=digest(fsOps.readFileSync(safePath(rootPath,'AGENTS.md',fsOps,{allowMissing:false,requireFile:true})));
  const v2GuardSha256=digest(fsOps.readFileSync(safePath(rootPath,'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs',fsOps,{allowMissing:false,requireFile:true})));
  const revocations=readR9R08V3Json(rootPath,R9R08_V3_REVOCATION_REF,fsOps);
  const material=readR9R08V3Json(rootPath,R9R08_V3_MATERIAL_REF,fsOps);
  const semanticReview=readR9R08V3Json(rootPath,R9R08_V3_SEMANTIC_REVIEW_REF,fsOps);
  const freeze=readR9R08V3Json(rootPath,R9R08_V3_FREEZE_REF,fsOps);
  const candidate=readR9R08V3Json(rootPath,R9R08_V3_CANDIDATE_REF,fsOps);
  const liveReadSet=R9R08_V2_READ_SET.map(targetRef=>{
    const targetPath=safePath(rootPath,targetRef,fsOps,{allowMissing:false,requireFile:true});
    const bytes=fsOps.readFileSync(targetPath);
    return {targetRef,sha256:digest(bytes),bytes};
  });
  const decisionLogText=liveReadSet.find(row=>row.targetRef==='.product-experience/decision-log.md').bytes.toString('utf8');
  const roleAdmission=validateR9R08V3TechnicalSourceDelegation({delegation:delegation.value,policy:policy.value,
    policySha256:policy.sha256,rootBoundaryDecision:rootDecision.value,rootBoundaryDecisionSha256:rootDecision.sha256,
    agentsSha256,v2GuardSha256,revocationRegister:revocations.value,revocationRegisterSha256:revocations.sha256,liveReadSet,decisionLogText});
  if(delegation.value.candidateRef!==R9R08_V3_CANDIDATE_REF||delegation.value.candidateSha256!==candidate.sha256
    ||delegation.value.freezeRef!==R9R08_V3_FREEZE_REF||delegation.value.freezeSha256!==freeze.sha256
    ||delegation.value.semanticReviewRef!==R9R08_V3_SEMANTIC_REVIEW_REF||delegation.value.semanticReviewSha256!==semanticReview.sha256
    ||delegation.value.profileId!==R9R08_V3_PROFILE_ID||candidate.value.candidateRevision!=='R9-R08'
    ||freeze.value.candidateBundle?.sha256!==candidate.sha256
    ||semanticReview.value.reviewStatus!=='PASS_FOR_SELECTED_CANDIDATE_SEMANTICS_ONLY_BLOCKED_FOR_CURRENTNESS_AND_AUTHORITY_CHAIN'
    ||semanticReview.value.semanticDisposition?.status!=='PASS_FOR_FROZEN_R9_R08_SELECTED_CUT_ONLY')
    throw new Error('R9-R08 v3 delegation does not bind the fixed candidate, freeze, independent semantic review, and profile');
  validateR9R08V2SemanticPin({material:material.value,decisionLogText});
  const targets=R9R08_V2_WRITE_TARGETS.map(targetRef=>{
    const row=delegation.value.targetRows.find(entry=>entry.targetRef===targetRef);
    const frozen=freeze.value.selectedPostimages?.find(entry=>entry.targetRef===targetRef);
    const preimageBytes=liveReadSet.find(entry=>entry.targetRef===targetRef)?.bytes;
    if(!row||!frozen||!preimageBytes)throw new Error(`R9-R08 v3 exact target or frozen postimage is missing: ${targetRef}`);
    const postimagePath=safePath(rootPath,frozen.postimageRef,fsOps,{allowMissing:false,requireFile:true});
    const postimageBytes=fsOps.readFileSync(postimagePath);
    if(digest(preimageBytes)!==row.preimageSha256||digest(postimageBytes)!==row.postimageSha256
      ||row.postimageSha256!==frozen.postimageSha256)throw new Error(`R9-R08 v3 target or frozen postimage pin differs: ${targetRef}`);
    return {targetRef,expectedPreimageSha256:row.preimageSha256,expectedPostimageSha256:row.postimageSha256,preimageBytes,postimageBytes};
  });
  const fingerprints=[delegation,policy,rootDecision,{ref:'AGENTS.md',sha256:agentsSha256},
    {ref:'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs',sha256:v2GuardSha256},revocations,material,semanticReview,freeze,candidate,
    ...liveReadSet.map(row=>({ref:row.targetRef,sha256:row.sha256})),
    ...targets.map(row=>({ref:`frozen-postimage:${row.targetRef}`,sha256:digest(row.postimageBytes)}))]
    .map(row=>[row.ref??R9R08_V3_ROOT_DECISION_REF,row.sha256]);
  return {delegation:delegation.value,delegationSha256:delegation.sha256,decisionLogText,liveReadSet,targets,roleAdmission,
    fingerprints,preflightSha256:digest(Buffer.from(JSON.stringify(fingerprints)))};
}

/** Read-only v3 readiness probe for a future root-delegated technical source-only apply. */
export function inspectMediaPdp0RootSelectedSourceIntegrationR9R08V3TechnicalReadiness(){
  const rootPath=physicalRoot(fs,FIXED_REPOSITORY_ROOT);
  try{
    const state=loadR9R08V3TechnicalSourceState(rootPath,fs);
    return {blocked:false,canonicalApply:'NONE',profileId:R9R08_V3_PROFILE_ID,roleAdmission:state.roleAdmission,
      readSetCount:state.liveReadSet.length,writeTargetCount:state.targets.length};
  }catch(error){return {blocked:true,blocker:error.message,canonicalApply:'NONE',sourceWrites:'NONE',profileId:R9R08_V3_PROFILE_ID};}
}

/**
 * Fixed v3 source-only technical writer. It accepts no caller identity or paths;
 * a current root-delegation record is required. Existing v2 native-trust admission
 * and its protected effect remain unchanged and are not consulted as this lane's authority.
 */
export function commitValidatedPdp0RootSelectedSourceIntegrationR9R08V3Technical(input={}){
  requireExactPublicInput(input,[],'R9-R08 v3 technical source-only CAS');
  const rootPath=physicalRoot(fs,FIXED_REPOSITORY_ROOT);
  const preflight=loadR9R08V3TechnicalSourceState(rootPath,fs);
  const validateUnderLease=()=>{
    let current;
    try{current=loadR9R08V3TechnicalSourceState(rootPath,fs);}
    catch(error){throw new Error(`R9-R08 v3 delegation, policy, revocation, semantic pin, whole-log CAS, or seven-file read set changed after preflight; no snapshots or writes: ${error.message}`);}
    if(current.preflightSha256!==preflight.preflightSha256)
      throw new Error('R9-R08 v3 delegation, policy, revocation, semantic pin, whole-log CAS, or seven-file read set changed after preflight; no snapshots or writes');
    return current;
  };
  const applyRole=preflight.delegation.roles.find(row=>row.role==='PDP0_TECHNICAL_APPLY_AUTHORITY');
  let result;
  try{
    result=commitSourceAmendmentTargets({rootPath,candidateSha256:preflight.delegation.candidateSha256,
      decisionRef:applyRole.decisionRef,decisionSectionSha256:applyRole.decisionSectionSha256,
      applyAuthorizationSha256:preflight.delegationSha256,targets:preflight.targets,
      allowedTargetRefs:R9R08_V2_WRITE_TARGETS,
      journalSchemaVersion:'media.pdp0.root-selected-source-integration-r9-r08-v3-technical-source-only-apply-journal.v1',
      beforePrepare:validateUnderLease,fsOps:fs});
  }catch(error){
    const journalRef=`${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/${preflight.delegation.candidateSha256}.json`;
    let journalExists=false;
    try{journalExists=fs.existsSync(safePath(rootPath,journalRef,fs));}catch{}
    if(journalExists){
      let journalState='UNREADABLE_REQUIRES_RECONCILIATION';
      try{journalState=JSON.parse(fs.readFileSync(safePath(rootPath,journalRef,fs,{allowMissing:false,requireFile:true}),'utf8')).state??journalState;}catch{}
      let observedTargets=[];
      try{observedTargets=R9R08_V2_WRITE_TARGETS.map(targetRef=>{
        const actual=digest(fs.readFileSync(safePath(rootPath,targetRef,fs,{allowMissing:false,requireFile:true})));
        const expected=preflight.delegation.targetRows.find(row=>row.targetRef===targetRef);
        return {targetRef,sha256:actual,state:actual===expected?.preimageSha256?'PREIMAGE_OBSERVED':actual===expected?.postimageSha256?'POSTIMAGE_OBSERVED':'OTHER_HASH_REQUIRES_RECONCILIATION'};
      });}catch{observedTargets=R9R08_V2_WRITE_TARGETS.map(targetRef=>({targetRef,status:'UNREADABLE_REQUIRES_RECONCILIATION'}));}
      error.effectState='UNKNOWN_PARTIAL_EFFECTS_REQUIRES_EXPLICIT_RECONCILIATION';
      error.journalRef=journalRef;error.journalState=journalState;error.observedTargets=observedTargets;
      error.message=`${error.message}; ${error.effectState}; journal=${journalRef}; state=${journalState}`;
    }else{error.effectState='NO_NEW_TARGET_EFFECTS_BY_THIS_ATTEMPT';error.message=`${error.message}; ${error.effectState}`;}
    throw error;
  }
  return {...result,preflightSha256:preflight.preflightSha256,profileId:R9R08_V3_PROFILE_ID,
    effect:R9R08_V3_EFFECT,canonicalApply:result.canonicalWrite==='PERFORMED'?'EXACT_R9_R08_SOURCE_ONLY_TECHNICAL_APPLY_PERFORMED':'NONE',
    nativeTrust:'NOT_USED',pdpAcceptance:'NONE',nativeReceipt:'NONE',build:'NONE',delivery:'NONE',release:'NONE'};
}

/** Read-only v2 admission probe; missing authority is reported without mutation. */
export function validateMediaPdp0RootSelectedSourceIntegrationR9R08V2ReadSetUnderLease({fsOps=fs}={}){
  const rootPath=physicalRoot(fsOps,FIXED_REPOSITORY_ROOT);
  const lockRef=`${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/.canonical-source-amendment-cas.lock`;
  return withOwnerLock(rootPath,lockRef,fsOps,()=>{
    const authorizationPath=safePath(rootPath,R9R08_V2_APPLY_AUTHORIZATION_REF,fsOps);
    if(!fsOps.existsSync(authorizationPath))return {blocked:true,blocker:'DISTINCT_EXACT_INPUT_APPLY_AUTHORIZATION_NOT_RECORDED',canonicalApply:'NONE'};
    try{
      const state=loadR9R08V2WriterState(rootPath,fsOps);
      // The read-only probe deliberately has no actor evidence input. It reports
      // the exact guard blocker rather than treating caller labels as authority.
      validateR9R08V2WriterState(state);
      return {blocked:false,canonicalApply:'NONE',readSetCount:7,writeTargetCount:4};
    }catch(error){return {blocked:true,blocker:error.message,canonicalApply:'NONE',sourceWrites:'NONE'};}
  });
}

/** Read-only readiness probe for the versioned R9-R02 four-target source profile. */
export function prepareMediaPdp0RootSelectedSourceIntegrationR9R02CasPlan() {
  const rootPath=physicalRoot(fs,FIXED_REPOSITORY_ROOT);
  const prepared=prepareMediaPdp0RootSelectedSourceIntegrationR9R02ApplicationPlan({persistArtifacts:false});
  const candidatePlan=prepared.plan;
  try{
    const journalRef=`${SOURCE_AMENDMENT_OBSERVATIONS}/source-amendment-journals/${candidatePlan.candidateBundle.sha256}.json`;
    const journalPath=safePath(rootPath,journalRef,fs);
    const journal=fs.existsSync(journalPath)?readR9Json(rootPath,journalRef).value:null;
    const expectedTargets=candidatePlan.targets.map(row=>({...row,
      expectedPreimageSha256:row.preimageSha256,
      expectedPostimageSha256:row.postimageSha256,
      preimageBytes:(()=>{
        const current=fs.readFileSync(safePath(rootPath,row.targetRef,fs,{allowMissing:false,requireFile:true}));
        if(r9Sha(current)===row.preimageSha256)return current;
        const snapshotRef=journal?.targets?.find(entry=>entry.targetRef===row.targetRef)?.immutablePreimageRef;
        if(!snapshotRef)throw new Error(`current preimage changed without an exact R9-R02 journal snapshot: ${row.targetRef}`);
        const snapshot=fs.readFileSync(safePath(rootPath,snapshotRef,fs,{allowMissing:false,requireFile:true}));
        if(r9Sha(snapshot)!==row.preimageSha256)throw new Error(`journal preimage snapshot differs from the frozen R9-R02 baseline: ${row.targetRef}`);
        return snapshot;
      })(),
      postimageBytes:fs.readFileSync(safePath(rootPath,row.postimageRef,fs,{allowMissing:false,requireFile:true})),
    }));
    const ownerFile=readR9Json(rootPath,R9_PROFILE.sourceOwnerDecisionRef);
    const rootFile=readR9Json(rootPath,R9_PROFILE.rootAdoptionDecisionRef);
    const registrationFile=readR9Json(rootPath,R9_PROFILE.registrationRef);
    const authorizationFile=readR9Json(rootPath,R9_PROFILE.applyAuthorizationRef);
    const authorization=authorizationFile.value;
    const plan={...candidatePlan,planDisposition:'READY_FOR_EXACT_R9_R02_FOUR_TARGET_CAS',blockers:[],
      sourceOwnerDecisionSha256:r9Sha(ownerFile.bytes),rootAdoptionDecisionSha256:r9Sha(rootFile.bytes),
      profileRegistrationSha256:r9Sha(registrationFile.bytes),applyAuthorizationSha256:r9Sha(authorizationFile.bytes),
      decisionRef:authorization.decisionRef,decisionSectionSha256:authorization.decisionSectionSha256,
      current7Preimages:candidatePlan.current7Preimages.map(row=>({targetRef:row.targetRef,sha256:row.expectedSha256}))};
    validateR9R02AuthorityAndProjection(rootPath,plan,expectedTargets);
    return {plan,targets:expectedTargets,blocked:false};
  }catch(error){
    return {plan:{...candidatePlan,planDisposition:'BLOCKED',blockers:[...new Set([...(candidatePlan.blockers??[]),error.message])],canonicalApply:'NONE'},targets:[],blocked:true};
  }
}

/** Exact R9-R02 writer; authority and currentness are rechecked under the shared CAS lock. */
export function commitValidatedPdp0RootSelectedSourceIntegrationR9R02(input={}){
  requireExactPublicInput(input,['plan','targets'],'R9-R02 four-target source-amendment CAS');
  const {plan,targets}=input;
  const rootPath=physicalRoot(fs,FIXED_REPOSITORY_ROOT);
  validateR9R02AuthorityAndProjection(rootPath,plan,targets);
  const current=()=>validateR9R02AuthorityAndProjection(rootPath,plan,targets);
  return commitSourceAmendmentTargets({rootPath,candidateSha256:plan.candidateBundle.sha256,decisionRef:plan.decisionRef,
    decisionSectionSha256:plan.decisionSectionSha256,applyAuthorizationSha256:plan.applyAuthorizationSha256,targets,
    allowedTargetRefs:R9_WRITE_TARGETS,journalSchemaVersion:'media.pdp0.root-selected-source-integration-r9-r02-apply-journal.v1',
    beforePrepare:current,fsOps:fs});
}

export function commitValidatedPdp0SourceAmendment(input) {
  if (input?.plan?.schemaVersion === 'media.pdp0.source-amendment-cas-plan.six-file.v1'
      || input?.plan?.candidateSchemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v7') {
    return commitValidatedPdp0SourceAmendmentSixFile(input);
  }
  if (input?.plan?.schemaVersion === 'media.pdp0.source-amendment-cas-plan.v2'
      || input?.plan?.candidateSchemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v4') {
    return commitValidatedPdp0SourceAmendmentV4(input);
  }
  const {root, candidateSha256, decisionRef, decisionSectionSha256, applyAuthorizationSha256, targets, fsOps = fs} = input ?? {};
  const rootPath = physicalRoot(fsOps, root);
  return commitSourceAmendmentTargets({rootPath, candidateSha256, decisionRef, decisionSectionSha256,
    applyAuthorizationSha256, targets, allowedTargetRefs: SOURCE_AMENDMENT_TARGETS,
    journalSchemaVersion: 'media.pdp0.source-amendment-apply-journal.v1', fsOps});
}

function validateV4SourceAmendmentPlan(plan, targets) {
  const shaPattern = /^[a-f0-9]{64}$/u;
  const expectedFields = [
    'schemaVersion', 'planKind', 'planDisposition', 'candidateRef', 'candidateSchemaVersion',
    'candidateSha256', 'candidatePostimageSha256', 'sourceOwnerDecisionRef', 'sourceOwnerDecisionSha256',
    'technicalPeerReviewRef', 'technicalPeerReviewSha256', 'decisionRef', 'decisionSectionSha256',
    'applyAuthorizationSha256', 'sourceOwnerIdentity', 'sourceOwnerRole', 'peerIdentity', 'blockers', 'targets',
    'authorityBoundary',
  ];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
      || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(expectedFields.slice().sort())) {
    throw new Error('v4 source-amendment CAS requires the exact root-reviewed plan contract');
  }
  if (plan.schemaVersion !== 'media.pdp0.source-amendment-cas-plan.v2'
      || plan.planKind !== 'NON_MUTATING_EXACT_SOURCE_OWNER_MULTI_FILE_CAS_PLAN'
      || plan.planDisposition !== 'REVIEWED_AWAITING_EXPLICIT_APPLY_AUTHORIZATION'
      || plan.candidateRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v4.json'
      || plan.candidateSchemaVersion !== 'media.pdp0.aud-spec-002-source-amendment-candidate.v4'
      || plan.sourceOwnerDecisionRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v4.json'
      || plan.technicalPeerReviewRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-independent-peer.v4.json'
      || !shaPattern.test(plan.candidateSha256 ?? '') || !shaPattern.test(plan.candidatePostimageSha256 ?? '')
      || !shaPattern.test(plan.sourceOwnerDecisionSha256 ?? '') || !shaPattern.test(plan.technicalPeerReviewSha256 ?? '')
      || !shaPattern.test(plan.decisionSectionSha256 ?? '') || !shaPattern.test(plan.applyAuthorizationSha256 ?? '')
      || plan.sourceOwnerIdentity !== 'agent:/root' || plan.sourceOwnerRole !== 'PDP0_SOURCE_OWNER'
      || typeof plan.peerIdentity !== 'string' || !plan.peerIdentity || plan.peerIdentity === plan.sourceOwnerIdentity
      || !/^\.product-experience\/decision-log\.md#PXD-\d{3}$/u.test(plan.decisionRef ?? '')
      || !Array.isArray(plan.blockers) || plan.blockers.length !== 0
      || !Array.isArray(plan.targets) || plan.targets.length !== SOURCE_AMENDMENT_TARGETS_V4.length
      || !Array.isArray(targets) || targets.length !== SOURCE_AMENDMENT_TARGETS_V4.length) {
    throw new Error('v4 source-amendment CAS plan is incomplete or not explicitly reviewed');
  }
  const expectedBoundary = {
    ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE',
    runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED',
  };
  if (JSON.stringify(canonical(plan.authorityBoundary)) !== JSON.stringify(canonical(expectedBoundary))) {
    throw new Error('v4 source-amendment plan authority boundary is invalid');
  }
  const targetPlanByRef = new Map(plan.targets.map(row => [row?.targetRef, row]));
  const actualTargetByRef = new Map(targets.map(row => [row?.targetRef, row]));
  if (plan.targets.some(row => !row || typeof row.targetRef !== 'string' || !shaPattern.test(row.expectedPreimageSha256 ?? '')
      || !shaPattern.test(row.expectedPostimageSha256 ?? '')) || targetPlanByRef.size !== SOURCE_AMENDMENT_TARGETS_V4.length
      || actualTargetByRef.size !== SOURCE_AMENDMENT_TARGETS_V4.length
      || JSON.stringify(plan.targets.map(row => row.targetRef)) !== JSON.stringify(SOURCE_AMENDMENT_TARGETS_V4)
      || JSON.stringify(targets.map(row => row.targetRef)) !== JSON.stringify(SOURCE_AMENDMENT_TARGETS_V4)
      || SOURCE_AMENDMENT_TARGETS_V4.some(ref => targetPlanByRef.get(ref)?.expectedPreimageSha256 !== actualTargetByRef.get(ref)?.expectedPreimageSha256
        || targetPlanByRef.get(ref)?.expectedPostimageSha256 !== actualTargetByRef.get(ref)?.expectedPostimageSha256)) {
    throw new Error('v4 source-amendment plan does not bind the exact four target preimages and postimages');
  }
  if (plan.targets.some((row, index) => digest(targets[index].preimageBytes ?? Buffer.alloc(0)) !== row.expectedPreimageSha256
      || digest(targets[index].postimageBytes ?? Buffer.alloc(0)) !== row.expectedPostimageSha256)) {
    throw new Error('v4 source-amendment bytes differ from the exact reviewed plan');
  }
}

/** Exact v4 four-file source amendment CAS. The v2 three-file API remains separate. */
export function commitValidatedPdp0SourceAmendmentV4({root, plan, targets, fsOps = fs}) {
  validateV4SourceAmendmentPlan(plan, targets);
  const rootPath = physicalRoot(fsOps, root);
  return commitSourceAmendmentTargets({rootPath, candidateSha256: plan.candidateSha256, decisionRef: plan.decisionRef,
    decisionSectionSha256: plan.decisionSectionSha256, applyAuthorizationSha256: plan.applyAuthorizationSha256,
    targets, allowedTargetRefs: SOURCE_AMENDMENT_TARGETS_V4,
    journalSchemaVersion: 'media.pdp0.source-amendment-apply-journal.v2', fsOps});
}

function validateSixFileSourceAmendmentPlan(plan, targets) {
  const shaPattern = /^[a-f0-9]{64}$/u;
  const expectedFields = [
    'schemaVersion', 'planKind', 'planDisposition', 'candidateRef', 'candidateSchemaVersion',
    'candidateSha256', 'candidatePostimageSha256', 'sourceOwnerDecisionRef', 'sourceOwnerDecisionSha256',
    'technicalPeerReviewRef', 'technicalPeerReviewSha256', 'applyAuthorizationRef', 'decisionRef', 'decisionSectionSha256',
    'applyAuthorizationSha256', 'sourceOwnerIdentity', 'sourceOwnerRole', 'peerIdentity', 'rootGrantRef', 'rootGrantCurrent', 'blockers', 'targets',
    'authorityBoundary','requiredSourceOwnerDecisionSchemaRef','requiredApplyAuthorizationSchemaRef','journalRef','effects',
  ];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
      || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(expectedFields.slice().sort())) {
    throw new Error('six-file source-amendment CAS requires the exact root-reviewed plan contract');
  }
  if (plan.schemaVersion !== 'media.pdp0.source-amendment-cas-plan.six-file.v1'
      || plan.planKind !== 'NON_MUTATING_EXACT_SOURCE_OWNER_MULTI_FILE_CAS_PLAN'
      || plan.planDisposition !== 'READY_EXACT_V7_CUT_WITH_CURRENT_ROOT_GRANT_NO_WRITE_PERFORMED'
      || plan.candidateRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v7.json'
      || plan.candidateSchemaVersion !== 'media.pdp0.aud-spec-002-source-amendment-candidate.v7'
      || plan.candidateSha256 !== 'c7f510c6cf3f17be31c8fb50e36f06ea92db7f64337dbd91ee7f8273f4014dcc'
      || plan.candidatePostimageSha256 !== 'd1e0b9b8cea7e7f23aa339fd4a12cde29fc9d14b52e821e8a00f8f113fb8d187'
      || plan.sourceOwnerDecisionRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v7.json'
      || plan.technicalPeerReviewRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-independent-peer.v7.json'
      || plan.applyAuthorizationRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-apply-authorization.v7.json'
      || plan.rootGrantRef !== plan.applyAuthorizationRef || plan.rootGrantCurrent !== true
      || !shaPattern.test(plan.sourceOwnerDecisionSha256 ?? '') || !shaPattern.test(plan.technicalPeerReviewSha256 ?? '')
      || !shaPattern.test(plan.decisionSectionSha256 ?? '') || !shaPattern.test(plan.applyAuthorizationSha256 ?? '')
      || plan.sourceOwnerIdentity !== V7_SOURCE_OWNER_IDENTITY || plan.sourceOwnerRole !== 'PDP0_SOURCE_OWNER'
      || plan.peerIdentity !== V7_DISTINCT_PEER_IDENTITY || plan.peerIdentity === plan.sourceOwnerIdentity
      || plan.decisionRef !== '.product-experience/decision-log.md#PXD-226'
      || plan.decisionSectionSha256 !== V7_DECISION_SECTION_SHA256
      || plan.requiredSourceOwnerDecisionSchemaRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v7.schema.json'
      || plan.requiredApplyAuthorizationSchemaRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-apply-authorization.v7.schema.json'
      || plan.journalRef !== `docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals/${plan.candidateSha256}.json`
      || JSON.stringify(canonical(plan.effects)) !== JSON.stringify(canonical({canonicalWrite:'NOT_PERFORMED',sourceStatus:'UNCHANGED',phaseStatus:'UNCHANGED',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'}))
      || !Array.isArray(plan.blockers) || plan.blockers.length !== 0
      || !Array.isArray(plan.targets) || plan.targets.length !== SOURCE_AMENDMENT_TARGETS_SIX_FILE.length
      || !Array.isArray(targets) || targets.length !== SOURCE_AMENDMENT_TARGETS_SIX_FILE.length) {
    throw new Error('six-file source-amendment CAS plan is incomplete or not explicitly reviewed');
  }
  const expectedBoundary = {
    ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE',
    runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED',
  };
  if (JSON.stringify(canonical(plan.authorityBoundary)) !== JSON.stringify(canonical(expectedBoundary))) {
    throw new Error('six-file source-amendment plan authority boundary is invalid');
  }
  const targetPlanByRef = new Map(plan.targets.map(row => [row?.targetRef, row]));
  const actualTargetByRef = new Map(targets.map(row => [row?.targetRef, row]));
  if (plan.targets.some(row => !row || typeof row.targetRef !== 'string' || !shaPattern.test(row.expectedPreimageSha256 ?? '')
      || !shaPattern.test(row.expectedPostimageSha256 ?? '')) || targetPlanByRef.size !== SOURCE_AMENDMENT_TARGETS_SIX_FILE.length
      || actualTargetByRef.size !== SOURCE_AMENDMENT_TARGETS_SIX_FILE.length
      || JSON.stringify(plan.targets.map(row => row.targetRef)) !== JSON.stringify(SOURCE_AMENDMENT_TARGETS_SIX_FILE)
      || JSON.stringify(targets.map(row => row.targetRef)) !== JSON.stringify(SOURCE_AMENDMENT_TARGETS_SIX_FILE)
      || SOURCE_AMENDMENT_SIX_FILE_V7_PINS.some(({targetRef, preimageSha256, postimageSha256}) => targetPlanByRef.get(targetRef)?.expectedPreimageSha256 !== preimageSha256
        || targetPlanByRef.get(targetRef)?.expectedPostimageSha256 !== postimageSha256
        || actualTargetByRef.get(targetRef)?.expectedPreimageSha256 !== preimageSha256
        || actualTargetByRef.get(targetRef)?.expectedPostimageSha256 !== postimageSha256)) {
    throw new Error('six-file source-amendment plan does not bind the exact six target preimages and postimages');
  }
  if (plan.targets.some((row, index) => digest(targets[index].preimageBytes ?? Buffer.alloc(0)) !== row.expectedPreimageSha256
      || digest(targets[index].postimageBytes ?? Buffer.alloc(0)) !== row.expectedPostimageSha256)) {
    throw new Error('six-file source-amendment bytes differ from the exact reviewed plan');
  }
}

/** Exact installed-repository v7 writer; authority is rebuilt under the CAS lock using native filesystem reads. */
export function commitValidatedPdp0SourceAmendmentSixFile(input = {}) {
  requireExactPublicInput(input,['plan','targets'],'six-file source-amendment CAS');
  const {plan,targets}=input;
  validateSixFileSourceAmendmentPlan(plan, targets);
  const rootPath = physicalRoot(fs, FIXED_REPOSITORY_ROOT);
  const rebuildCurrentPlan = () => {
    const current = prepareMediaPdp0SourceAmendmentV7CasPlan({root:rootPath});
    if (JSON.stringify(canonical(current.plan)) !== JSON.stringify(canonical(plan))) {
      throw new Error('v7 fixed owner, peer, or current-root-grant records changed since CAS preflight');
    }
    validateSixFileSourceAmendmentPlan(current.plan, current.targets);
  };
  return commitSourceAmendmentTargets({rootPath, candidateSha256: plan.candidateSha256, decisionRef: plan.decisionRef,
    decisionSectionSha256: plan.decisionSectionSha256, applyAuthorizationSha256: plan.applyAuthorizationSha256,
    targets, allowedTargetRefs: SOURCE_AMENDMENT_TARGETS_SIX_FILE,
    journalSchemaVersion: 'media.pdp0.source-amendment-apply-journal.six-file.v1',beforePrepare:rebuildCurrentPlan,fsOps:fs});
}

function validateQualityTwoTargetPlan(plan, targets) {
  const shaPattern = /^[a-f0-9]{64}$/u;
  const keys = [
    'schemaVersion','planKind','planDisposition','candidateRef','candidateSchemaVersion','candidateSha256','candidatePostimageSha256',
    'sourceOwnerDecisionRef','sourceOwnerDecisionSha256','technicalPeerReviewRef','technicalPeerReviewSha256','v7Predecessor',
    'decisionRef','decisionSectionSha256','applyAuthorizationSha256','sourceOwnerIdentity','sourceOwnerRole','peerIdentity','blockers','targets','authorityBoundary',
  ];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
      || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(keys.slice().sort())) {
    throw new Error('quality two-target CAS requires the exact adoption-plan contract');
  }
  if (plan.schemaVersion !== 'media.pdp0.quality-extension-source-adoption-cas-plan.v2'
      || plan.planKind !== 'NON_MUTATING_EXACT_TWO_TARGET_QUALITY_EXTENSION_SOURCE_CAS_PLAN'
      || plan.planDisposition !== 'READY_FOR_SHARED_OWNER_CONTROLLED_CAS'
      || plan.candidateRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-candidate.v2.json'
      || plan.candidateSchemaVersion !== 'media.pdp0.quality-extension-source-candidate.v2'
      || !shaPattern.test(plan.candidateSha256 ?? '') || !shaPattern.test(plan.candidatePostimageSha256 ?? '')
      || plan.sourceOwnerDecisionRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-owner-decision.v2.json'
      || !shaPattern.test(plan.sourceOwnerDecisionSha256 ?? '')
      || plan.technicalPeerReviewRef !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-independent-peer.v2.json'
      || !shaPattern.test(plan.technicalPeerReviewSha256 ?? '')
      || plan.decisionRef !== '.product-experience/decision-log.md#PXD-227'
      || !shaPattern.test(plan.decisionSectionSha256 ?? '') || !shaPattern.test(plan.applyAuthorizationSha256 ?? '')
      || plan.sourceOwnerIdentity !== 'agent:/root' || plan.sourceOwnerRole !== 'PDP0_SOURCE_OWNER'
      || typeof plan.peerIdentity !== 'string' || !plan.peerIdentity || plan.peerIdentity === plan.sourceOwnerIdentity
      || plan.peerIdentity === 'agent:/root/phase_io'
      || !Array.isArray(plan.blockers) || plan.blockers.length !== 0
      || !Array.isArray(plan.targets) || plan.targets.length !== 2
      || !Array.isArray(targets) || targets.length !== 2) {
    throw new Error('quality two-target CAS plan is incomplete, blocked, or not explicitly authorized');
  }
  if (!plan.v7Predecessor || plan.v7Predecessor.manifestRef !== `${SOURCE_AMENDMENT_OBSERVATIONS}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`
      || plan.v7Predecessor.peerRef !== `${SOURCE_AMENDMENT_OBSERVATIONS}/AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`
      || !shaPattern.test(plan.v7Predecessor.manifestSha256 ?? '') || !shaPattern.test(plan.v7Predecessor.peerSha256 ?? '')
      || plan.v7Predecessor.state !== 'EXACT_CURRENT_READBACK' || !Array.isArray(plan.v7Predecessor.targets)
      || plan.v7Predecessor.targets.length !== QUALITY_V7_PREDECESSOR_TARGETS.length
      || JSON.stringify(plan.v7Predecessor.targets.map(row => row?.targetRef)) !== JSON.stringify(QUALITY_V7_PREDECESSOR_TARGETS)
      || plan.v7Predecessor.targets.some(row => !shaPattern.test(row.expectedPreimageSha256 ?? '')
        || !shaPattern.test(row.expectedPostimageSha256 ?? '') || row.actualSha256 !== row.expectedPostimageSha256)) {
    throw new Error('quality two-target CAS does not bind the exact current six-target v7 predecessor readback');
  }
  const boundary = {sourceOwnerAdoption:'EXACT_DECISION_RECORDED',canonicalApply:'NOT_PERFORMED',sourceCurrentness:'NOT_CLAIMED',
    phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED'};
  if (JSON.stringify(canonical(plan.authorityBoundary)) !== JSON.stringify(canonical(boundary))) {
    throw new Error('quality two-target CAS authority boundary is invalid');
  }
  const planRows = new Map(plan.targets.map(row => [row?.targetRef, row]));
  const actualRows = new Map(targets.map(row => [row?.targetRef, row]));
  if (JSON.stringify(plan.targets.map(row => row?.targetRef)) !== JSON.stringify(QUALITY_TWO_TARGETS)
      || JSON.stringify(targets.map(row => row?.targetRef)) !== JSON.stringify(QUALITY_TWO_TARGETS)
      || planRows.size !== QUALITY_TWO_TARGETS.length || actualRows.size !== QUALITY_TWO_TARGETS.length
      || plan.targets.some(row => !row || !shaPattern.test(row.expectedPreimageSha256 ?? '') || !shaPattern.test(row.expectedPostimageSha256 ?? ''))
      || QUALITY_TWO_TARGETS.some(ref => planRows.get(ref)?.expectedPreimageSha256 !== actualRows.get(ref)?.expectedPreimageSha256
        || planRows.get(ref)?.expectedPostimageSha256 !== actualRows.get(ref)?.expectedPostimageSha256)
      || targets.some((row, index) => digest(row.preimageBytes ?? Buffer.alloc(0)) !== plan.targets[index].expectedPreimageSha256
        || digest(row.postimageBytes ?? Buffer.alloc(0)) !== plan.targets[index].expectedPostimageSha256)) {
    throw new Error('quality two-target CAS does not bind the exact ordered decision-log and quality-policy bytes');
  }
  const aggregatePostimage = digest(Buffer.from(JSON.stringify(plan.targets.map(({targetRef,expectedPreimageSha256,expectedPostimageSha256}) =>
    ({targetRef,preimageSha256:expectedPreimageSha256,postimageSha256:expectedPostimageSha256})))));
  if (aggregatePostimage !== plan.candidatePostimageSha256) throw new Error('quality candidate aggregate target fingerprint is inconsistent');
}

/** Exact quality-policy plus PXD-227 decision-log CAS; publication and recovery use the shared transaction core. */
export function commitValidatedPdp0SourceAmendmentQualityTwoTarget(input = {}) {
  requireExactPublicInput(input,['plan','targets'],'quality two-target CAS');
  const {plan,targets}=input;
  validateQualityTwoTargetPlan(plan, targets);
  const rootPath = physicalRoot(fs, FIXED_REPOSITORY_ROOT);
  const readSource = ref => {
    if (ref.startsWith('../ghatana-lifecycle/') || ref.startsWith('ghatana-lifecycle:')) {
      if (!QUALITY_LIFECYCLE_SOURCE_REFS.has(ref)) throw new Error(`quality CAS source is outside its fixed sibling allowlist: ${ref}`);
      const siblingRoot = path.resolve(rootPath,'../ghatana-lifecycle');
      const siblingStat = fs.lstatSync(siblingRoot);
      if (siblingStat.isSymbolicLink() || !siblingStat.isDirectory()) throw new Error('quality CAS Lifecycle sibling root must be a physical directory');
      const physicalSiblingRoot = physicalRoot(fs,siblingRoot);
      if (physicalSiblingRoot !== siblingRoot) throw new Error('quality CAS Lifecycle sibling root must be canonical');
      const relativeRef = ref.startsWith('ghatana-lifecycle:')
        ? ref.slice('ghatana-lifecycle:'.length)
        : ref.slice('../ghatana-lifecycle/'.length);
      return fs.readFileSync(safePath(physicalSiblingRoot,relativeRef,fs,{allowMissing:true,requireFile:true}));
    }
    return fs.readFileSync(safePath(rootPath,ref,fs,{allowMissing:true,requireFile:true}));
  };
  const rebuildCurrentPlan = () => {
    const current = planQualityExtensionSourceAdoptionV2({readSource});
    const currentAuthorizationSha256=digest(readSource('docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-apply-authorization.v2.json'));
    if(currentAuthorizationSha256!==plan.applyAuthorizationSha256){
      throw new Error('quality apply-authorization bytes changed or are not the exact canonical frozen record');
    }
    if (JSON.stringify(canonical(current.plan)) !== JSON.stringify(canonical(plan))) {
      throw new Error('quality candidate, predecessor, peer, owner decision, or apply authorization changed since CAS preflight');
    }
    if (current.plan.planDisposition !== 'READY_FOR_SHARED_OWNER_CONTROLLED_CAS' || current.plan.blockers.length !== 0) {
      throw new Error('quality two-target CAS is blocked by current fixed source records');
    }
  };
  return commitSourceAmendmentTargets({rootPath,candidateSha256:plan.candidateSha256,decisionRef:plan.decisionRef,
    decisionSectionSha256:plan.decisionSectionSha256,applyAuthorizationSha256:plan.applyAuthorizationSha256,
    targets,allowedTargetRefs:QUALITY_TWO_TARGETS,
    journalSchemaVersion:'media.pdp0.quality-extension-source-adoption-apply-journal.v2',beforePrepare:rebuildCurrentPlan,fsOps:fs});
}
