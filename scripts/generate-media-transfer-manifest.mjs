import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'migration/evidence/media-transfer-manifest-candidate-2026-10-12.json');
const pathMapPath = resolve(root, 'migration/path-map.yaml');
const inventoryPath = resolve(root, 'migration/source-inventory.yaml');
const exceptionsPath = resolve(root, 'migration/transfer-exceptions.yaml');
const crosswalkPath = resolve(root, 'docs/migration/evidence/media-source-target-tree-crosswalk-current-2026-10-12.json');

const localRepos = new Map([
  ['samujjwal/ghatana', resolve(root, '../ghatana')],
  ['samujjwal/ghatana-media', root],
  ['samujjwal/ghatana-shared', resolve(root, '../ghatana-shared')],
  ['samujjwal/ghatana-products', resolve(root, '../ghatana-products')],
  ['samujjwal/ghatana-kernel', resolve(root, '../ghatana-kernel')],
  ['samujjwal/gharbatai', resolve(root, '../gharbatai')],
]);

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  return trimmed;
}

// Read only the flat record fields used by these migration evidence files. This
// intentionally avoids making the evidence generator depend on a YAML package.
export function parseRecordBlocks(text, listKey) {
  const lines = text.split(/\r?\n/);
  const marker = lines.findIndex((line) => new RegExp(`^${listKey}:\\s*$`).test(line));
  if (marker < 0) throw new Error(`Missing ${listKey}: record list`);
  const records = [];
  let current = null;
  let nested = null;
  for (const line of lines.slice(marker + 1)) {
    if (/^\S/.test(line) && line.trim() && !line.startsWith('- ')) break;
    const item = line.match(/^- ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (item) {
      current = { [item[1]]: parseScalar(item[2]) };
      records.push(current);
      nested = null;
      continue;
    }
    if (!current) continue;
    const nestedStart = line.match(/^  ([A-Za-z][A-Za-z0-9]*):\s*$/);
    if (nestedStart) {
      nested = nestedStart[1];
      current[nested] = {};
      continue;
    }
    const field = line.match(/^  ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (field) {
      nested = null;
      current[field[1]] = parseScalar(field[2]);
      continue;
    }
    const nestedField = line.match(/^    ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (nested && nestedField) current[nested][nestedField[1]] = parseScalar(nestedField[2]);
  }
  return records;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trimEnd();
}

function head(repo, ref = 'HEAD') {
  return git(repo, ['rev-parse', `${ref}^{commit}`]).trim();
}

function branch(repo) {
  return git(repo, ['branch', '--show-current']).trim() || '(detached HEAD)';
}

function readTree(repo, ref) {
  const raw = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', ref], {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
  }).toString('utf8');
  const tree = new Map();
  for (const record of raw.split('\0').filter(Boolean)) {
    const [meta, path] = record.split('\t');
    const [mode, type, objectId] = meta.split(' ');
    if (type === 'blob') tree.set(path, { mode, objectId });
  }
  return tree;
}

function key(repo, path) { return `${repo}\0${path}`; }

export function buildTransferManifest({ pathMap, inventory, exceptions, crosswalk, repoHeads, repoBranches, repoHeadRefs = {}, repoPaths, repoTrees, repoTreeStatuses = new Map() }) {
  const pathMapByKey = new Map(pathMap.map((entry) => [key(entry.sourceRepository, entry.sourcePath), entry]));
  const inventoryByKey = new Map(inventory.map((entry) => [key(entry.sourceRepository, entry.sourcePath), entry]));
  const exceptionsByKey = new Map(exceptions.map((entry) => [key(entry.sourceRepository, entry.sourcePath), entry]));
  const crosswalkByPath = new Map(crosswalk.entries.map((entry) => [entry.sourcePath, entry]));
  const sourceIdentities = new Map(pathMap.map((entry) => [key(entry.sourceRepository, entry.sourcePath), entry]));
  for (const crosswalkEntry of crosswalk.entries) {
    const id = key(crosswalk.source.repository, crosswalkEntry.sourcePath);
    if (!sourceIdentities.has(id)) sourceIdentities.set(id, {
      sourceRepository: crosswalk.source.repository,
      sourcePath: crosswalkEntry.sourcePath,
      targetRepository: 'samujjwal/ghatana-media',
      targetPath: crosswalkEntry.targetPath,
      disposition: 'UNRESOLVED_OWNER_REVIEW_REQUIRED',
      ownership: null,
      inventoryGroup: null,
    });
  }
  const rows = [...sourceIdentities.values()].sort((a, b) => a.sourceRepository.localeCompare(b.sourceRepository)
    || a.sourcePath.localeCompare(b.sourcePath)).map((entry) => {
    const id = key(entry.sourceRepository, entry.sourcePath);
    const pathMapEntry = pathMapByKey.get(id);
    const sourceRecord = inventoryByKey.get(id) ?? null;
    const exception = exceptionsByKey.get(id) ?? null;
    const sourceRepoPath = repoPaths.get(entry.sourceRepository);
    const targetRepoPath = repoPaths.get(entry.targetRepository);
    const mediaCrosswalk = entry.sourceRepository === 'samujjwal/ghatana'
      ? crosswalkByPath.get(entry.sourcePath)
      : null;
    const sourceRevision = mediaCrosswalk ? crosswalk.source.revision : sourceRecord?.sourceRevision ?? entry.sourceRevision;
    const pinned = sourceRepoPath ? repoTrees.get(`${entry.sourceRepository}\0${sourceRevision}`)?.get(entry.sourcePath) ?? null : null;
    const currentSource = sourceRepoPath ? repoTrees.get(`${entry.sourceRepository}\0HEAD`)?.get(entry.sourcePath) ?? null : null;
    const currentTarget = targetRepoPath
      ? repoTrees.get(`${entry.targetRepository}\0HEAD`)?.get(exception?.targetPath ?? entry.targetPath) ?? null
      : null;
    const inventoryMode = sourceRecord?.sourceMode ?? pinned?.mode ?? null;
    const inventoryBlob = sourceRecord?.sourceFingerprint?.value ?? pinned?.objectId ?? null;
    const sourceMode = mediaCrosswalk?.sourceMode ?? pinned?.mode ?? inventoryMode;
    const sourceBlob = mediaCrosswalk?.sourceObjectId ?? pinned?.objectId ?? inventoryBlob;
    const mappedTargetPath = exception?.targetPath ?? entry.targetPath;
    return {
      sourceRepository: entry.sourceRepository,
      sourcePath: entry.sourcePath,
      sourceIdentity: {
        basis: mediaCrosswalk ? 'REFRESHED_MIG_01_COMMITTED_TREE_CROSSWALK'
          : pinned ? 'PATH_MAP_SOURCE_REVISION_COMMITTED_TREE'
            : 'SOURCE_INVENTORY_FINGERPRINT_ONLY',
        revision: mediaCrosswalk ? crosswalk.source.revision : sourceRevision,
        mode: sourceMode,
        blob: sourceBlob,
      },
      pathMapSnapshot: pathMapEntry ? {
        revision: pathMapEntry.sourceRevision,
        mode: inventoryMode,
        blob: inventoryBlob,
      } : null,
      currentSourceHeadObservation: {
        repositoryHead: repoHeads[entry.sourceRepository] ?? null,
        branch: repoBranches[entry.sourceRepository] ?? null,
        mode: currentSource?.mode ?? null,
        blob: currentSource?.objectId ?? null,
        present: Boolean(currentSource),
        observationStatus: repoTreeStatuses.get(`${entry.sourceRepository}\0HEAD`)?.status ?? (repoHeads[entry.sourceRepository] ? 'OBSERVED' : 'UNVERIFIABLE_REPOSITORY_HEAD_UNAVAILABLE'),
      },
      targetRepository: entry.targetRepository,
      targetPath: mappedTargetPath,
      targetHeadObservation: {
        repositoryHead: repoHeads[entry.targetRepository] ?? null,
        branch: repoBranches[entry.targetRepository] ?? null,
        mode: currentTarget?.mode ?? null,
        blob: currentTarget?.objectId ?? null,
        present: Boolean(currentTarget),
        observationStatus: repoTreeStatuses.get(`${entry.targetRepository}\0HEAD`)?.status ?? (repoHeads[entry.targetRepository] ? 'OBSERVED' : 'UNVERIFIABLE_REPOSITORY_HEAD_UNAVAILABLE'),
      },
      sourceIdentityObservationStatus: pinned ? 'PINNED_COMMIT_TREE_OBSERVED'
        : sourceRecord?.sourceFingerprint?.value ? 'HISTORICAL_INVENTORY_FINGERPRINT; PINNED_TREE_UNVERIFIABLE'
          : 'UNVERIFIABLE_SOURCE_IDENTITY',
      targetDisposition: entry.disposition,
      pathMapOwnershipLabel: entry.ownership ?? sourceRecord?.ownership ?? null,
      inventoryGroup: entry.inventoryGroup ?? sourceRecord?.inventoryGroup ?? null,
      sourceRole: sourceRecord?.sourceRole ?? null,
      sourceAuthorshipEvidence: sourceRecord?.sourceAuthorship ?? null,
      canonicalGenerator: null,
      canonicalGeneratorStatus: 'UNRESOLVED_OWNER_REVIEW_REQUIRED',
      namedOwner: null,
      namedOwnerStatus: 'UNRESOLVED_OWNER_REVIEW_REQUIRED',
      stateAndSecretsOwnership: 'UNRESOLVED_OWNER_REVIEW_REQUIRED',
      transferException: exception ? {
        classification: exception.classification,
        sourceMode: exception.sourceMode,
        sourceBlob: exception.sourceFingerprint,
        targetPath: exception.targetPath,
        targetModeAtExceptionSnapshot: exception.targetMode,
        targetBlobAtExceptionSnapshot: exception.targetFingerprint,
        reason: exception.reason,
      } : null,
      rollback: {
        proposedSourceRef: `${entry.sourceRepository}@${sourceRevision}:${entry.sourcePath}`,
        proposedTargetBeforeStateRef: `${entry.targetRepository}@${repoHeads[entry.targetRepository] ?? 'UNAVAILABLE'}:${mappedTargetPath}`,
        authority: 'UNRESOLVED_OWNER_REVIEW_REQUIRED',
        triggers: [
          'source-target contract or behavior mismatch',
          'affected consumer failure or unclassified consumer discovery',
          'identity, tenant, rights, consent, or finality invariant failure',
          'unverifiable source, artifact, database, secret, or deployment ownership',
          'agreed health or recovery signal fails during an admitted wave',
        ],
      },
      transferAuthorization: 'NOT_AUTHORIZED',
      canonicalWriterSwitchAuthorization: 'NOT_AUTHORIZED',
      executionWindow: null,
    };
  });
  return {
    schemaVersion: 'media.transfer-manifest-candidate.v1',
    recordDate: '2026-10-12',
    authority: 'LOCAL_REVERSIBLE_PREPARATION_ONLY',
    status: 'OWNER_REVIEW_REQUIRED_NOT_ADMITTED',
    transferAuthorization: 'NOT_AUTHORIZED',
    canonicalWriterSwitchAuthorization: 'NOT_AUTHORIZED',
    sourceOfTruth: 'samujjwal/ghatana:services/media remains canonical until separately admitted and executed cutover evidence exists.',
    sourceEvidence: {
      pathMapSchema: 'media.migration-path-map.v1',
      sourceInventorySchema: 'media.migration-source-inventory.v1',
      transferExceptionsSchema: 'media.migration-transfer-exceptions.v1',
      pathMapEntryCount: pathMap.length,
      sourceInventoryEntryCount: inventory.length,
      refreshedCrosswalkEntryCount: crosswalk.entries.length,
      transferExceptionCount: exceptions.length,
    sourceTreeCrosswalk: {
      path: 'docs/migration/evidence/media-source-target-tree-crosswalk-current-2026-10-12.json',
      source: crosswalk.source,
      target: crosswalk.target,
      counts: crosswalk.counts,
    },
      crosswalkHeadAlignment: {
      status: crosswalk.unverifiable === true || crosswalk.status === 'UNVERIFIABLE' ? 'UNVERIFIABLE' : 'OBSERVED',
      sourceCrosswalkRevision: crosswalk.source.revision,
      sourceObservedHead: repoHeads[crosswalk.source.repository] ?? null,
      sourceAligned: crosswalk.unverifiable !== true && crosswalk.status !== 'UNVERIFIABLE'
        && crosswalk.source.revision === (repoHeads[crosswalk.source.repository] ?? null),
      targetCrosswalkRevision: crosswalk.target.revision,
      targetObservedHead: repoHeads[crosswalk.target.repository] ?? null,
      targetAligned: crosswalk.unverifiable !== true && crosswalk.status !== 'UNVERIFIABLE'
        && crosswalk.target.revision === (repoHeads[crosswalk.target.repository] ?? null),
    },
      repositories: Object.fromEntries(Object.keys(repoHeads).sort().map((repository) => [repository, {
        head: repoHeads[repository], branch: repoBranches[repository], ref: repoHeadRefs[repository] ?? null,
      }])),
      consumerInventory: {
        path: 'migration/consumer-inventory.yaml',
        capturedDate: '2026-10-04',
        authority: 'BOUNDED_LOCAL_CHECKOUT_SCAN_NOT_EXHAUSTIVE_OWNER_CONFIRMATION',
      },
    },
    globalGates: {
      sourceOwnerApproval: 'PENDING',
      affectedConsumerOwnerApprovals: 'PENDING',
      packageSecurityAcceptanceDecisions: 'PENDING_AS_APPLICABLE',
      exactReleaseBranchAndEnvironmentInventory: 'PENDING',
      refreshedCrosswalkAgainstObservedSourceHead: crosswalk.unverifiable === true || crosswalk.status === 'UNVERIFIABLE'
        ? 'UNVERIFIABLE'
        : crosswalk.source.revision === (repoHeads[crosswalk.source.repository] ?? null)
          ? 'CURRENT_FOR_OBSERVED_HEAD'
          : 'PENDING_SOURCE_HEAD_RECONCILIATION',
      nonProductionRollbackRehearsal: 'PENDING',
      signedChangeWindow: 'PENDING',
      databaseDataAndSecretOwnership: 'UNRESOLVED_OWNER_REVIEW_REQUIRED',
      sourceDeletion: 'NOT_AUTHORIZED',
      canonicalAuthorityChange: 'NOT_AUTHORIZED',
    },
    summary: {
      exactPathCount: rows.length,
      ownerResolvedCount: rows.filter((row) => row.namedOwnerStatus !== 'UNRESOLVED_OWNER_REVIEW_REQUIRED').length,
      generatorResolvedCount: rows.filter((row) => row.canonicalGeneratorStatus !== 'UNRESOLVED_OWNER_REVIEW_REQUIRED').length,
      transferAuthorizedCount: rows.filter((row) => row.transferAuthorization === 'AUTHORIZED').length,
      currentSourceObservationUnavailableCount: rows.filter((row) => row.currentSourceHeadObservation.observationStatus !== 'OBSERVED').length,
      currentSourcePathAbsentCount: rows.filter((row) => row.currentSourceHeadObservation.observationStatus === 'OBSERVED' && !row.currentSourceHeadObservation.present).length,
      currentTargetObservationUnavailableCount: rows.filter((row) => row.targetHeadObservation.observationStatus !== 'OBSERVED').length,
      currentTargetPathAbsentCount: rows.filter((row) => row.targetHeadObservation.observationStatus === 'OBSERVED' && !row.targetHeadObservation.present).length,
    },
    entries: rows,
  };
}

function createCurrentManifest() {
  const pathMap = parseRecordBlocks(readFileSync(pathMapPath, 'utf8'), 'entries');
  const inventory = parseRecordBlocks(readFileSync(inventoryPath, 'utf8'), 'entries');
  const exceptions = parseRecordBlocks(readFileSync(exceptionsPath, 'utf8'), 'records');
  const crosswalk = JSON.parse(readFileSync(crosswalkPath, 'utf8'));
  if (!Array.isArray(crosswalk.entries) || crosswalk.unverifiable === true || crosswalk.status === 'UNVERIFIABLE') {
    throw new Error(`MIG-02 current source crosswalk is UNVERIFIABLE; inspect ${crosswalkPath} and preserve it for diagnosis`);
  }
  const repoHeads = {};
  const repoBranches = {};
  const repoHeadRefs = {};
  for (const repository of new Set([...pathMap.map((row) => row.sourceRepository), ...pathMap.map((row) => row.targetRepository)])) {
    const localPath = localRepos.get(repository);
    if (!localPath) continue;
    try {
      const cutRef = ['samujjwal/ghatana', 'samujjwal/ghatana-media'].includes(repository) ? 'origin/main' : 'HEAD';
      repoHeads[repository] = head(localPath, cutRef);
      repoHeadRefs[repository] = cutRef;
      repoBranches[repository] = branch(localPath);
    } catch {
      // Keep an unavailable repository explicit in evidence rather than inventing its revision.
    }
  }
  const repoTrees = new Map();
  const repoTreeStatuses = new Map();
  const sourceRevisions = new Map();
  for (const row of inventory) {
    if (!sourceRevisions.has(row.sourceRepository)) sourceRevisions.set(row.sourceRepository, new Set());
    if (row.sourceRevision) sourceRevisions.get(row.sourceRepository).add(row.sourceRevision);
  }
  for (const [repository, localPath] of localRepos) {
    if (!repoHeads[repository]) continue;
    try {
      const currentRef = repoHeadRefs[repository] ?? 'HEAD';
      repoTrees.set(`${repository}\0HEAD`, readTree(localPath, currentRef));
      repoTreeStatuses.set(`${repository}\0HEAD`, { status: 'OBSERVED', ref: currentRef });
    } catch (error) {
      repoTreeStatuses.set(`${repository}\0HEAD`, { status: 'UNVERIFIABLE', reason: String(error.message ?? error) });
    }
    for (const revision of sourceRevisions.get(repository) ?? []) {
      try {
        repoTrees.set(`${repository}\0${revision}`, readTree(localPath, revision));
        repoTreeStatuses.set(`${repository}\0${revision}`, { status: 'OBSERVED' });
      } catch (error) {
        repoTreeStatuses.set(`${repository}\0${revision}`, { status: 'UNVERIFIABLE', reason: String(error.message ?? error) });
      }
    }
  }
  return buildTransferManifest({ pathMap, inventory, exceptions, crosswalk, repoHeads, repoBranches, repoHeadRefs, repoPaths: localRepos, repoTrees, repoTreeStatuses });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = `${JSON.stringify(createCurrentManifest(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const actual = readFileSync(outputPath, 'utf8');
    if (actual !== expected) {
      console.error('MIG-02 transfer manifest is stale; run node scripts/generate-media-transfer-manifest.mjs');
      process.exit(1);
    }
    console.log(`MIG-02 transfer manifest is current (${JSON.parse(actual).entries.length} source paths; no transfer authorized).`);
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, expected);
    console.log(`Wrote ${outputPath}`);
  }
}
