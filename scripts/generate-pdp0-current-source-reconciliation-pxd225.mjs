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
const topologySuccessorPath = 'docs/implementation/observations/media-discovery-topology-56-surface-successor-2026-10-31.json';
const pxd225LocatorCommit = '0f85319fcc28ed163341ba5027bfbc5b64137ddb';
const topologySuccessorCommit = '86dbc4b1efaabb1f8a7c63d7ee5839d0a9176f8c';
const expectedPxd225CommitParent = 'f8816aede965d55c27005d5bab13bcb6ae376389';
const expectedTopologySuccessorParent = '8e470c5dbd837c4c44429bc9d6aba6b6de51d313';
const expectedTopologySuccessorSha256 = '36fd5d406516013d167f939c00820ee3554242185c723c500fb0345ccb87ef0e';
const expectedPxd207SectionSha256 = 'eedde5bd30fabed060af9a1b8b16bf55f4a5648331950daaf3ca860d99d7ec3a';
const expectedPxd225SectionSha256 = 'd979ecb41cc0e67f9304f3ba8283a20949ee64e23f70216f4bac53c3cab6f811';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readText = file => fs.readFileSync(path.join(root, file), 'utf8');
const parseYaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;

function committedText(commit, file) {
  return execFileSync('git', ['show', `${commit}:${file}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024,
  });
}

function assertExactPxd225AndTopologySources(currentChannelsText, topologySuccessor, decisionLogText,
  {show = committedText, runGit = execFileSync, read = readText} = {}) {
  const commitParent = runGit('git', ['rev-parse', `${pxd225LocatorCommit}^`], {cwd: root, encoding: 'utf8'}).trim();
  const successorParentSha = runGit('git', ['rev-parse', `${topologySuccessorCommit}^`], {cwd: root, encoding: 'utf8'}).trim();
  if (commitParent !== expectedPxd225CommitParent || successorParentSha !== expectedTopologySuccessorParent) {
    throw new Error('PXD-225 or the authorized topology-successor commit parent differs from its pinned source cut');
  }
  runGit('git', ['merge-base', '--is-ancestor', pxd225LocatorCommit, topologySuccessorCommit], {cwd: root, stdio: 'ignore'});

  const predecessorText = show(commitParent, channelsPath);
  const pxd225PostimageText = show(pxd225LocatorCommit, channelsPath);
  const r1ParentText = show(expectedTopologySuccessorParent, channelsPath);
  const r1PostimageText = show(topologySuccessorCommit, channelsPath);
  const predecessor = parseYaml(predecessorText);
  const pxd225Postimage = parseYaml(pxd225PostimageText);
  const r1Parent = parseYaml(r1ParentText);
  const r1Postimage = parseYaml(r1PostimageText);
  if (currentChannelsText !== r1PostimageText) {
    throw new Error('PXD-225 current applications-channels bytes do not equal the exact authorized 86dbc4b1 postimage');
  }

  const archivedId = 'media.channel.legacy-desktop';
  const archivedLocator = 'archive/media-desktop-apps/ai-voice-desktop/README.md';
  const retainedLocator = 'archive/media-desktop-apps/desktop/README.md';
  const channel = document => document.channels?.find(row => row.id === archivedId);
  const oldChannel = channel(predecessor);
  const pxd225Channel = channel(pxd225Postimage);
  const currentChannel = channel(r1Postimage);
  if (!oldChannel || !pxd225Channel || !currentChannel
      || predecessor.channels.filter(row => row.id === archivedId).length !== 1
      || pxd225Postimage.channels.filter(row => row.id === archivedId).length !== 1
      || r1Postimage.channels.filter(row => row.id === archivedId).length !== 1) {
    throw new Error('expected exactly one legacy-desktop channel across the pinned PXD-225 and topology source cuts');
  }
  const removedSuffix = ` and ${archivedLocator}`;
  if (!oldChannel.evidence.endsWith(removedSuffix)
      || pxd225Channel.evidence !== oldChannel.evidence.slice(0, -removedSuffix.length)
      || pxd225Channel.evidence !== retainedLocator
      || JSON.stringify(pxd225Channel) !== JSON.stringify(currentChannel)) {
    throw new Error('the PXD-225 locator removal or preservation of its postimage channel row is not proven');
  }
  for (const key of Object.keys(pxd225Channel)) {
    if (key !== 'evidence' && pxd225Channel[key] !== oldChannel[key]) throw new Error(`PXD-225 changed legacy-desktop non-evidence field ${key}`);
  }
  const expectedPxd225Postimage = structuredClone(predecessor);
  expectedPxd225Postimage.channels.find(row => row.id === archivedId).evidence = pxd225Channel.evidence;
  if (JSON.stringify(expectedPxd225Postimage) !== JSON.stringify(pxd225Postimage)) {
    throw new Error('PXD-225 locator-removal commit changes more than the archived evidence locator in applications-channels');
  }

  const r1Text = read(topologySuccessorPath);
  const actualR1 = JSON.parse(r1Text);
  if (sha256(r1Text) !== expectedTopologySuccessorSha256
      || JSON.stringify(topologySuccessor) !== JSON.stringify(actualR1)
      || topologySuccessor.schemaVersion !== 'media.discovery-successor-impact.v1'
      || topologySuccessor.recordId !== 'MEDIA-DISCOVERY-TOPOLOGY-56-SURFACE-SUCCESSOR-2026-10-31-R1'
      || topologySuccessor.predecessor?.physicalManifestCandidates !== 26
      || topologySuccessor.predecessor?.compositions !== 7
      || topologySuccessor.predecessor?.logicalConsumers !== 21
      || topologySuccessor.predecessor?.totalSurfaceIdentities !== 54
      || topologySuccessor.successor?.physicalManifestCandidates !== 28
      || topologySuccessor.successor?.compositions !== 7
      || topologySuccessor.successor?.logicalConsumers !== 21
      || topologySuccessor.successor?.totalSurfaceIdentities !== 56
      || topologySuccessor.decision?.meaningChange !== 'NO_PDP0_MEANING_CHANGE'
      || !topologySuccessor.refreshedDerivedRecords?.includes(`${channelsPath}#coordinatorDefinitionExtensionApplicability/denominator`)) {
    throw new Error('PXD-225 topology successor does not match the exact authorized R1 denominator disposition');
  }
  const dataCloud = topologySuccessor.sourceDeltas?.find(row => row.surfaceId === 'media.physical.adapters-data-cloud-media');
  const agentTools = topologySuccessor.sourceDeltas?.find(row => row.surfaceId === 'media.physical.adapters-agent-tools-media');
  const ocr = topologySuccessor.sourceDeltas?.find(row => row.surfaceId === 'media.physical.adapters-ocr-compat');
  if (topologySuccessor.sourceDeltas?.length !== 3
      || dataCloud?.changeKind !== 'SURFACE_ADDED' || dataCloud.pdp0Disposition !== 'APPLICABLE'
      || dataCloud.classification !== 'DELEGATED_PORT_BOUNDARY_BINDING' || dataCloud.meaningIdsChanged?.length !== 0
      || agentTools?.changeKind !== 'SURFACE_ADDED' || agentTools.pdp0Disposition !== 'NOT_APPLICABLE_SUPPORT'
      || agentTools.meaningIdsChanged?.length !== 0
      || ocr?.changeKind !== 'SURFACE_RETIRED' || ocr.classification !== 'OCR_M03_RETIREMENT_COMPLETED'
      || ocr.meaningIdsChanged?.length !== 0) {
    throw new Error('PXD-225 topology successor has unrecorded or meaning-changing surface dispositions');
  }

  const predecessorDenominator = pxd225Postimage.coordinatorDefinitionExtensionApplicability?.denominator;
  const successorDenominator = r1Postimage.coordinatorDefinitionExtensionApplicability?.denominator;
  const r1ParentDenominator = r1Parent.coordinatorDefinitionExtensionApplicability?.denominator;
  if (!predecessorDenominator || !successorDenominator || !r1ParentDenominator
      || predecessorDenominator.physicalSurfaces !== topologySuccessor.predecessor.physicalManifestCandidates
      || predecessorDenominator.totalSurfaceIdentities !== topologySuccessor.predecessor.totalSurfaceIdentities
      || successorDenominator.physicalSurfaces !== topologySuccessor.successor.physicalManifestCandidates
      || successorDenominator.totalSurfaceIdentities !== topologySuccessor.successor.totalSurfaceIdentities
      || r1ParentDenominator.physicalSurfaces !== topologySuccessor.predecessor.physicalManifestCandidates
      || r1ParentDenominator.totalSurfaceIdentities !== topologySuccessor.predecessor.totalSurfaceIdentities) {
    throw new Error('PXD-225 topology successor denominator bytes do not match its R1 disposition');
  }
  for (const key of Object.keys(predecessorDenominator)) {
    if (!['physicalSurfaces', 'totalSurfaceIdentities'].includes(key)
        && predecessorDenominator[key] !== successorDenominator[key]) throw new Error(`R1 changed an unrecorded denominator field ${key}`);
  }
  const expectedR1Postimage = structuredClone(r1Parent);
  expectedR1Postimage.coordinatorDefinitionExtensionApplicability.denominator.physicalSurfaces = topologySuccessor.successor.physicalManifestCandidates;
  expectedR1Postimage.coordinatorDefinitionExtensionApplicability.denominator.totalSurfaceIdentities = topologySuccessor.successor.totalSurfaceIdentities;
  if (JSON.stringify(expectedR1Postimage) !== JSON.stringify(r1Postimage)) {
    throw new Error('86dbc4b1 source successor changes applications-channels beyond its two authorized denominator fields');
  }

  const predecessorRows = pxd225Postimage.coordinatorDefinitionExtensionApplicability?.records;
  const successorRows = r1Postimage.coordinatorDefinitionExtensionApplicability?.records;
  if (!Array.isArray(predecessorRows) || !Array.isArray(successorRows) || predecessorRows.length !== 7
      || successorRows.length !== predecessorRows.length) throw new Error('R1 applicability successor must preserve the exact seven PXD-207 extension rows');
  const expectedAuthorizedSuccessor = structuredClone(pxd225Postimage);
  const expectedRows = expectedAuthorizedSuccessor.coordinatorDefinitionExtensionApplicability.records;
  expectedAuthorizedSuccessor.coordinatorDefinitionExtensionApplicability.denominator.physicalSurfaces = topologySuccessor.successor.physicalManifestCandidates;
  expectedAuthorizedSuccessor.coordinatorDefinitionExtensionApplicability.denominator.totalSurfaceIdentities = topologySuccessor.successor.totalSurfaceIdentities;
  let changedApplicabilityRows = 0;
  for (let index = 0; index < predecessorRows.length; index += 1) {
    const before = predecessorRows[index];
    const after = successorRows[index];
    if (before.capabilityRef !== after.capabilityRef) throw new Error('R1 reordered or replaced a PXD-207 extension applicability row');
    const beforeExcluded = before.decision?.excludedSurfaceRefs;
    const afterExcluded = after.decision?.excludedSurfaceRefs;
    if (!Array.isArray(beforeExcluded) || !Array.isArray(afterExcluded)) throw new Error('R1 PXD-207 extension row is missing its excludedSurfaceRefs list');
    const additions = afterExcluded.filter(entry => !beforeExcluded.some(old => JSON.stringify(old) === JSON.stringify(entry)));
    if (additions.length === 0) {
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`R1 changed unrecorded applicability fields for ${before.capabilityRef}`);
      continue;
    }
    const rationalePrefix = `PXD-207 excludes ${before.capabilityRef} from media.physical.adapters-data-cloud-media:`;
    if (additions.length !== 1 || additions[0].surfaceRef !== 'media.physical.adapters-data-cloud-media'
        || !additions[0].rationale?.startsWith(rationalePrefix)
        || JSON.stringify(afterExcluded) !== JSON.stringify([additions[0], ...beforeExcluded])) {
      throw new Error(`R1 applicability addition is not the recorded Data Cloud exclusion for ${before.capabilityRef}`);
    }
    const expectedRow = structuredClone(before);
    expectedRow.decision.excludedSurfaceRefs = [additions[0], ...beforeExcluded];
    if (JSON.stringify(expectedRow) !== JSON.stringify(after)) throw new Error(`R1 changed unrecorded applicability fields for ${before.capabilityRef}`);
    expectedRows[index].decision.excludedSurfaceRefs = [additions[0], ...expectedRows[index].decision.excludedSurfaceRefs];
    changedApplicabilityRows += 1;
  }
  if (changedApplicabilityRows !== 7) throw new Error('R1 must add the recorded Data Cloud exclusion to exactly seven PXD-207 extension rows');
  if (JSON.stringify(expectedAuthorizedSuccessor) !== JSON.stringify(r1Postimage)) {
    throw new Error('the PXD-225 to R1 successor source delta includes unrecorded applications-channels changes');
  }

  const pxd207 = fingerprintPxdDecisionSection(decisionLogText, 'PXD-207').sha256;
  if (pxd207 !== expectedPxd207SectionSha256) throw new Error('R1 topology disposition is not bound to the pinned PXD-207 decision section');
  const pxd225 = fingerprintPxdDecisionSection(decisionLogText, 'PXD-225').sha256;
  if (pxd225 !== expectedPxd225SectionSha256) throw new Error('PXD-225 decision section differs from its authorized currentness selector');
  return {
    locatorRemoval: {
      commit: pxd225LocatorCommit,
      parentCommit: expectedPxd225CommitParent,
      predecessorChannelsSha256: sha256(predecessorText),
      postimageChannelsSha256: sha256(pxd225PostimageText),
      effect: 'REMOVED_ABSENT_ARCHIVED_CHANNEL_EVIDENCE_LOCATOR_ONLY',
    },
    authorizedTopologySuccessor: {
      recordRef: topologySuccessorPath,
      recordSha256: expectedTopologySuccessorSha256,
      commit: topologySuccessorCommit,
      parentCommit: expectedTopologySuccessorParent,
      parentChannelsSha256: sha256(r1ParentText),
      postimageChannelsSha256: sha256(r1PostimageText),
      decisionRef: '.product-experience/decision-log.md#PXD-207',
      decisionSectionSha256: pxd207,
      denominator: {
        physicalSurfaces: {predecessor: topologySuccessor.predecessor.physicalManifestCandidates, successor: topologySuccessor.successor.physicalManifestCandidates},
        totalSurfaceIdentities: {predecessor: topologySuccessor.predecessor.totalSurfaceIdentities, successor: topologySuccessor.successor.totalSurfaceIdentities},
      },
      excludedSurfaceRef: 'media.physical.adapters-data-cloud-media',
      excludedPxd207ExtensionCount: changedApplicabilityRows,
      meaningChange: 'NO_PDP0_MEANING_CHANGE',
    },
  };
}

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

export function selectPxd225PredecessorFromHistory(currentChannels, commits) {
  for (const commit of commits) {
    if (!commit || !commit.postimage || !commit.parentImage
        || JSON.stringify(commit.postimage) !== JSON.stringify(currentChannels)) continue;
    const predecessor = selectCommittedPxd225Predecessor(commit.postimage, commit.parentImage);
    if (predecessor === commit.parentImage) return predecessor;
  }
  return currentChannels;
}

function committedChannelHistory(currentChannels) {
  const hashes = execFileSync('git', ['log', '--all', '--full-history', '--format=%H', '-Sai-voice-desktop/README.md', '--', channelsPath], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
  }).trim().split(/\s+/u).filter(hash => /^[0-9a-f]{40}$/u.test(hash));
  const history = [];
  for (const hash of hashes) {
    const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', hash], {
      cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
    }).trim().split(/\s+/u).slice(1);
    if (parents.length !== 1) continue;
    try {
      const show = ref => parseYaml(execFileSync('git', ['show', `${ref}:${channelsPath}`], {
        cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      }));
      history.push({postimage: show(hash), parentImage: show(parents[0])});
    } catch {
      // Older repository-history records can predate this source path.
    }
  }
  return selectPxd225PredecessorFromHistory(currentChannels, history);
}

function historicalCapabilities(predecessor) {
  const commit = predecessor.sourceCut?.repositoryHead;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('PXD-223 must identify the historical source commit');
  return execFileSync('git', ['show', `${commit}:.product-experience/pdp-0-product-truth/capabilities.yaml`], {
    cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
}

export function buildPxd225Reconciliation({read = readText, historicalText, committedRead = committedText, gitExec = execFileSync} = {}) {
  const predecessor = JSON.parse(read(predecessorPath));
  const review = JSON.parse(read(reviewPath));
  const topologySuccessor = JSON.parse(read(topologySuccessorPath));
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

  const channelsText = read(channelsPath);
  const decisionLogText = read(decisionPath);
  const sourceProvenance = assertExactPxd225AndTopologySources(channelsText, topologySuccessor, decisionLogText, {
    show: committedRead,
    runGit: gitExec,
    read,
  });
  const channels = parseYaml(channelsText);
  const archivedId = 'media.channel.legacy-desktop';
  const archivedLocator = 'archive/media-desktop-apps/ai-voice-desktop/README.md';
  const retainedLocator = 'archive/media-desktop-apps/desktop/README.md';
  const predecessorChannels = parseYaml(committedRead(expectedPxd225CommitParent, channelsPath));
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
  const decision = fingerprintPxdDecisionSection(decisionLogText, 'PXD-225');
  return {
    schemaVersion: 'media.pdp0.current-source-reconciliation.v1',
    decisionRef: '.product-experience/decision-log.md#PXD-225',
    phaseScope: 'PDP-0',
    reviewKind: 'COORDINATOR_AUTHORED_CURRENT_SOURCE_RECONCILIATION',
    sourceCut: {workingTree: 'CURRENT_SOURCE_CUT', sourceCount: 2, authorizedCurrentnessSuccessorCount: 1},
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
      sourceProvenance,
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
