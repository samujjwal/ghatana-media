import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildSemanticSourceJoins } from './media-build-semantic-source-joins.mjs';

const tracePath = 'docs/implementation/MEDIA-BUILD-IDENTITY-TRACE.v1.json';
const planPath = 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md';
const outputPath = 'docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json';
const readJson = (root, path) => JSON.parse(fs.readFileSync(`${root}/${path}`, 'utf8'));
const sha256 = (root, path) => crypto.createHash('sha256').update(fs.readFileSync(`${root}/${path}`)).digest('hex');
const keyOf = row => `${row.phase}:${row.kind}:${row.identity}`;
const canonical = value => JSON.stringify(value, (key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function parsePlanPackages(text) {
  const headers = [...text.matchAll(/^### (M-BLD-[FVLX]\d{2}) — (.+)$/gm)];
  return headers.map((match, index) => {
    const section = text.slice(match.index, headers[index + 1]?.index ?? text.length);
    const dependencyText = section.match(/\*\*Dependencies:\*\*([^\n]+)/)?.[1] ?? '';
    const role = section.match(/\*\*Owner \/ exclusive write boundary:\*\*\s*(.*?)(?=\s+\*\*Dependencies:\*\*|\n|$)/s)?.[1]?.trim()
      ?? section.match(/\*\*Owner:\*\*\s*([^\n]+)/)?.[1]?.trim()
      ?? null;
    return {
      id: match[1], title: match[2],
      dependencies: [...dependencyText.matchAll(/M-BLD-[FVLX]\d{2}/g)].map(item => item[0]),
      ownerRole: role
    };
  });
}

export function buildMediaBuildContractBridge({ root = process.cwd() } = {}) {
  const traceSource = readJson(root, tracePath);
  const semantic = buildSemanticSourceJoins({ root, traceRows: traceSource.traceRows });
  const planText = fs.readFileSync(`${root}/${planPath}`, 'utf8');
  const packages = parsePlanPackages(planText);
  const packageById = new Map(packages.map(pkg => [pkg.id, pkg]));
  const semanticByKey = new Map(semantic.rows.map(row => [keyOf({ ...row, identity: row.identity }), row]));
  const identityRows = traceSource.traceRows.map(source => {
    const key = `${source.phase}:${source.kind}:${source.id}`;
    const bridge = semanticByKey.get(key);
    const packageId = source.primaryPackageId;
    const pkg = packageById.get(packageId);
    return {
      id: key,
      phase: source.phase,
      kind: source.kind,
      identity: source.id,
      sourceRecordSelectors: bridge?.sourceRecordSelectors ?? [],
      ownerAssignments: packageId === 'N/A' ? [{ packageId: 'N/A', status: 'SOURCE_AUTHORIZED', disposition: source.bindingState ?? source.applicability ?? null }] : [{
        packageId,
        ownerRole: pkg?.ownerRole ?? null,
        ownerRoleStatus: pkg?.ownerRole ? 'SOURCE_DECLARED' : 'UNRESOLVED_IN_SOURCE_PLAN',
        status: 'ASSIGNED_UNVERIFIED',
        sourceRef: `${planPath}#${packageId}`
      }],
      joins: bridge?.joins ?? {},
      unresolvedSourceSlots: bridge?.unresolvedSourceSlots ?? [`sourceIdentity:${source.kind}=${source.id}`],
      unresolvedSourceBlockers: bridge?.unresolvedSourceBlockers ?? [`SOURCE_MEMBERSHIP_UNRESOLVED:${source.phase}:${source.kind}:${source.id}`],
      codeSymbol: { status: 'UNBOUND', value: null },
      evidence: { status: 'PLANNING_RECEIPT_ONLY', refs: bridge?.sourceRecordSelectors ?? [] }
    };
  });
  const edges = [];
  for (const row of identityRows) for (const [relation, targets] of Object.entries(row.joins)) for (const target of targets) {
    edges.push({
      id: `${row.id}=>${relation}=>${target.phase}:${target.id}`,
      from: row.id,
      relation,
      toPhase: target.phase,
      toId: target.id,
      endpointClassification: target.endpointClassification ?? 'UNCLASSIFIED',
      targetSelector: target.targetSelector ?? null,
      sourceRef: target.sourceRef
    });
  }
  edges.sort((a, b) => a.id.localeCompare(b.id) || a.sourceRef.localeCompare(b.sourceRef));
  const sourceFiles = [...new Set([planPath, tracePath, ...semantic.sourceFiles])].sort();
  const populations = {};
  for (const row of identityRows) populations[`${row.phase}.${row.kind}`] = (populations[`${row.phase}.${row.kind}`] ?? 0) + 1;
  return {
    schemaVersion: 'media.build-contract-bridge.v1',
    authority: 'Generated source-bound BUILD contract bridge; planning evidence only.',
    stage: 'BUILD',
    phase: 'KDEV-STAGE-PLAN-IMPLEMENTATION',
    status: identityRows.some(row => row.unresolvedSourceBlockers.length) ? 'INCOMPLETE_SOURCE_RELATIONS' : 'SOURCE_RELATIONS_CURRENT',
    sourcePins: Object.fromEntries(sourceFiles.map(path => [path, sha256(root, path)])),
    census: { identityCount: identityRows.length, edgeCount: edges.length, populations },
    packages,
    identities: identityRows.sort((a, b) => a.id.localeCompare(b.id)),
    edges
  };
}

export function validateMediaBuildContractBridge(candidate, expected) {
  const errors = [];
  const identities = candidate?.identities ?? [];
  const expectedIdentities = expected?.identities ?? [];
  const identityIds = identities.map(row => row.id);
  if (new Set(identityIds).size !== identityIds.length) errors.push('duplicate bridge identity');
  if (canonical(identityIds) !== canonical(expectedIdentities.map(row => row.id))) errors.push('bridge identity census differs from source identities');
  if (canonical(candidate?.edges ?? []) !== canonical(expected?.edges ?? [])) errors.push('bridge edge set differs from source-declared joins');
  if (canonical(candidate?.sourcePins ?? {}) !== canonical(expected?.sourcePins ?? {})) errors.push('bridge source pins differ from current material sources');
  if (candidate?.census?.identityCount !== identities.length || candidate?.census?.edgeCount !== (candidate?.edges ?? []).length) errors.push('bridge census does not match records');
  for (const row of identities) {
    const owners = row.ownerAssignments ?? [];
    if (owners.length !== 1) errors.push(`identity ${row.id} must have exactly one owner disposition`);
    if (new Set(owners.map(owner => owner.packageId)).size !== owners.length) errors.push(`identity ${row.id} has duplicate owner assignment`);
    if (owners.some(owner => owner.packageId !== 'N/A' && !candidate.packages?.some(pkg => pkg.id === owner.packageId))) errors.push(`identity ${row.id} has an unknown package owner`);
    if (owners.some(owner => owner.packageId !== 'N/A' && ((owner.ownerRole && owner.ownerRoleStatus !== 'SOURCE_DECLARED') || (!owner.ownerRole && owner.ownerRoleStatus !== 'UNRESOLVED_IN_SOURCE_PLAN')))) errors.push(`identity ${row.id} has an unsubstantiated owner role`);
    if (row.codeSymbol?.status !== 'UNBOUND' || row.codeSymbol?.value !== null) errors.push(`identity ${row.id} has an unsupported code-symbol claim`);
    if (row.evidence?.status !== 'PLANNING_RECEIPT_ONLY') errors.push(`identity ${row.id} has an unsupported evidence status`);
  }
  const archivedNAs = expectedIdentities.filter(row => row.ownerAssignments?.some(owner => owner.packageId === 'N/A' && owner.disposition === 'ARCHIVED')).map(row => row.id);
  for (const id of archivedNAs) if (!identities.some(row => row.id === id && row.ownerAssignments?.some(owner => owner.packageId === 'N/A' && owner.disposition === 'ARCHIVED'))) errors.push(`source-authorized archived N/A identity missing: ${id}`);
  const packageIds = (candidate?.packages ?? []).map(pkg => pkg.id);
  const packageSet = new Set(packageIds);
  if (packageSet.size !== packageIds.length) errors.push('duplicate package identity');
  const visiting = new Set(); const visited = new Set();
  const byId = new Map((candidate?.packages ?? []).map(pkg => [pkg.id, pkg]));
  const visit = id => {
    if (visiting.has(id)) { errors.push(`illegal package dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!packageSet.has(dep)) errors.push(`unknown package dependency ${id} -> ${dep}`);
      else visit(dep);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of packageIds) visit(id);
  return [...new Set(errors)];
}

export const MEDIA_BUILD_CONTRACT_BRIDGE_PATH = outputPath;
