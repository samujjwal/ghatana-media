import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json';
const channelsPath = '.product-experience/pdp-0-product-truth/applications-channels.yaml';
const reviewPath = 'docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json';
const predecessorPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json';
const decisionPath = '.product-experience/decision-log.md';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readText = file => fs.readFileSync(path.join(root, file), 'utf8');
const parseYaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;

export function selectCommittedPxd225Predecessor(headChannels, parentChannels) {
  const archivedId = 'media.channel.legacy-desktop';
  const removedSuffix = ' and archive/media-desktop-apps/ai-voice-desktop/README.md';
  const headChannel = headChannels.channels?.find(row => row.id === archivedId);
  const parentChannel = parentChannels.channels?.find(row => row.id === archivedId);
  if (!headChannel || headChannel.evidence.endsWith(removedSuffix)
      || !parentChannel?.evidence.endsWith(removedSuffix)) return headChannels;
  const expectedHead = structuredClone(parentChannels);
  const expectedChannel = expectedHead.channels.find(row => row.id === archivedId);
  expectedChannel.evidence = expectedChannel.evidence.slice(0, -removedSuffix.length);
  return JSON.stringify(expectedHead) === JSON.stringify(headChannels) ? parentChannels : headChannels;
}

function historicalCapabilities(predecessor) {
  const commit = predecessor.sourceCut?.repositoryHead;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('PXD-223 must identify the historical source commit');
  return execFileSync('git', ['show', `${commit}:.product-experience/pdp-0-product-truth/capabilities.yaml`], {
    cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
}

export function buildPxd225Reconciliation({read = readText, historicalText} = {}) {
  const predecessor = JSON.parse(read(predecessorPath));
  const review = JSON.parse(read(reviewPath));
  const ids = review.reviewedCapabilityIds;
  if (!Array.isArray(ids) || ids.length !== 20 || new Set(ids).size !== 20) throw new Error('PXD-216 must retain its exact 20 unique capability IDs');
  const currentCapabilities = parseYaml(read('.product-experience/pdp-0-product-truth/capabilities.yaml'));
  const oldCapabilities = parseYaml(historicalText ?? historicalCapabilities(predecessor));
  const project = document => ids.map(id => {
    const matches = document.capabilities?.filter(row => row.id === id) ?? [];
    if (matches.length !== 1) throw new Error(`expected exactly one capability row for ${id}, found ${matches.length}`);
    return matches[0];
  });
  const historicalRows = project(oldCapabilities);
  const currentRows = project(currentCapabilities);
  const historicalRowsSha256 = sha256(JSON.stringify(historicalRows));
  const currentRowsSha256 = sha256(JSON.stringify(currentRows));
  if (historicalRowsSha256 !== predecessor.preservedSemanticReview?.historicalReviewedRowsSha256
      || currentRowsSha256 !== historicalRowsSha256) throw new Error('PXD-216 20-leaf semantic projection changed or differs from preserved PXD-223 evidence');

  const channels = parseYaml(read(channelsPath));
  const headChannelsText = execFileSync('git', ['show', `HEAD:${channelsPath}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  const archivedId = 'media.channel.legacy-desktop';
  const archivedLocator = 'archive/media-desktop-apps/ai-voice-desktop/README.md';
  const retainedLocator = 'archive/media-desktop-apps/desktop/README.md';
  const headChannels = parseYaml(headChannelsText);
  let predecessorChannels = headChannels;
  if (!headChannels.channels?.find(row => row.id === archivedId)?.evidence
    ?.endsWith(` and ${archivedLocator}`)) {
    // If HEAD is the commit that made the approved locator-only edit, compare
    // against its parent so the reconciliation remains reproducible afterward.
    const parentChannelsText = execFileSync('git', ['show', `HEAD^:${channelsPath}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    const parentChannels = parseYaml(parentChannelsText);
    predecessorChannels = selectCommittedPxd225Predecessor(headChannels, parentChannels);
  }
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], {cwd: root, encoding: 'utf8'}).trim() !== 'false') {
    throw new Error('PXD-225 requires complete local Git history to validate the absent archived evidence locator');
  }
  const archivedPathHistory = execFileSync('git', ['log', '--all', '--full-history', '--format=%H', '--', archivedLocator], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
  }).trim();
  const archivedPathExists = fs.existsSync(path.join(root, archivedLocator));
  const retainedPathExists = fs.existsSync(path.join(root, retainedLocator));
  if (archivedPathExists || archivedPathHistory || !retainedPathExists) {
    throw new Error('PXD-225 archive locator evidence is not proven: the removed path must be absent from the tree and history while the retained locator exists');
  }
  const channel = document => document.channels?.find(row => row.id === archivedId);
  const oldChannel = channel(predecessorChannels);
  const currentChannel = channel(channels);
  if (!oldChannel || !currentChannel || predecessorChannels.channels.filter(row => row.id === archivedId).length !== 1
      || channels.channels.filter(row => row.id === archivedId).length !== 1) throw new Error('expected one legacy-desktop channel in predecessor and current source');
  const removedSuffix = ` and ${archivedLocator}`;
  if (!oldChannel.evidence.endsWith(removedSuffix) || currentChannel.evidence !== oldChannel.evidence.slice(0, -removedSuffix.length)
      || oldChannel.definitionState !== currentChannel.definitionState || oldChannel.implementationState !== currentChannel.implementationState
      || oldChannel.qualificationState !== currentChannel.qualificationState || oldChannel.licenseAdmissionState !== currentChannel.licenseAdmissionState
      || oldChannel.runtimeAvailability !== currentChannel.runtimeAvailability || oldChannel.phase0Admission !== currentChannel.phase0Admission
      || oldChannel.supportRule !== currentChannel.supportRule) throw new Error('legacy-desktop change must remove only the absent archived evidence locator and preserve non-admission status');
  const expectedPredecessorChannels = structuredClone(predecessorChannels);
  const expectedPredecessorChannel = expectedPredecessorChannels.channels.find(row => row.id === archivedId);
  expectedPredecessorChannel.evidence = expectedPredecessorChannel.evidence.replace(` and ${archivedLocator}`, '');
  if (JSON.stringify(expectedPredecessorChannels) !== JSON.stringify(channels)) throw new Error('applications-channels semantic change includes fields beyond the exact archived locator removal');
  const channelsText = read(channelsPath);
  const decision = fingerprintPxdDecisionSection(read(decisionPath), 'PXD-225');
  return {
    schemaVersion: 'media.pdp0.current-source-reconciliation.v1',
    decisionRef: '.product-experience/decision-log.md#PXD-225',
    phaseScope: 'PDP-0',
    reviewKind: 'COORDINATOR_AUTHORED_CURRENT_SOURCE_RECONCILIATION',
    sourceCut: {workingTree: 'CURRENT_SOURCE_CUT', sourceCount: 2},
    predecessorRefs: [predecessorPath],
    authority: {
      phaseScope: 'PDP-0', ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED',
      acceptanceEffect: 'none', implementation: 'NOT_CLAIMED', runtimeAdmission: 'NOT_ADMITTED',
      qualification: 'NOT_EVALUATED', closure: 'NOT_CLAIMED', delivery: 'NOT_CLAIMED',
    },
    preservedSemanticReview: {
      decisionRef: '.product-experience/decision-log.md#PXD-216',
      artifactRef: reviewPath,
      reviewedCapabilityCount: ids.length,
      reviewedCapabilityIds: ids,
      historicalReviewedRowsSha256: historicalRowsSha256,
      currentReviewedRowsSha256: currentRowsSha256,
      changedReviewedCapabilityIds: [],
      semanticReviewStatus: 'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW',
    },
    preservedCurrentnessPredecessor: {
      decisionRef: '.product-experience/decision-log.md#PXD-223',
      artifactRef: predecessorPath,
      capabilitiesSha256: predecessor.currentSource?.capabilitiesSha256,
    },
    currentSource: {
      channelsPath,
      channelsSha256: sha256(channelsText),
      historicalReviewedRowsSha256: historicalRowsSha256,
      currentReviewedRowsSha256: currentRowsSha256,
      semanticChange: 'REMOVED_ABSENT_ARCHIVED_CHANNEL_EVIDENCE_LOCATOR_ONLY',
      removedEvidenceLocator: archivedLocator,
      retainedEvidenceLocator: retainedLocator,
      evidenceLocatorVerification: {
        removedPathCurrentTree: 'ABSENT',
        removedPathGitHistory: 'NO_COMMIT_PATH_FOUND',
        gitHistoryScope: 'COMPLETE_LOCAL_REPOSITORY_HISTORY',
        retainedPathCurrentTree: 'PRESENT',
      },
      channelRef: archivedId,
      supportStatePreserved: {
        definitionState: currentChannel.definitionState,
        implementationState: currentChannel.implementationState,
        qualificationState: currentChannel.qualificationState,
        licenseAdmissionState: currentChannel.licenseAdmissionState,
        runtimeAvailability: currentChannel.runtimeAvailability,
        phase0Admission: currentChannel.phase0Admission,
        supportRule: currentChannel.supportRule,
      },
    },
    decisionSectionSha256: decision.sha256,
    decisionEffect: 'PDP-0 current-source reconciliation only. PXD-216 remains the semantic review for its exact 20 capability IDs. No new semantic review, owner approval, independent acceptance, implementation verification, runtime admission, qualification, phase closure, or Delivery readiness is claimed.',
  };
}

function main() {
  const check = process.argv.includes('--check');
  const outputArg = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
  const output = path.resolve(root, outputArg ?? defaultOutput);
  const generated = `${JSON.stringify(buildPxd225Reconciliation(), null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== generated) {
      console.error(`PXD-225 reconciliation is stale: ${path.relative(root, output)}`);
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, generated);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
