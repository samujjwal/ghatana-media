import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topologyPath = path.join(repo, '.product-experience/surfaces/media-physical-topology.v1.json');
const source = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const ids = (p) => new Set([...source(p).matchAll(/^\s*-?\s*id:\s*['"]?([^\s,'"]+)/gm)].map((m) => m[1]));

export function validateTopology(topology, root = repo) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const candidates = topology.manifestCandidates ?? [];
  const byId = new Map(candidates.map((candidate) => [candidate.surfaceId, candidate]));
  if (topology.schemaVersion !== 'media.physical-topology.v1') fail('schemaVersion must be media.physical-topology.v1');
  if (candidates.length !== topology.activeManifestCandidateCount || candidates.length !== 26) fail('active manifest candidate count must remain exactly 26');
  if (new Set(candidates.map((candidate) => candidate.sourcePath)).size !== candidates.length) fail('physical source paths must be unique');
  if (new Set(candidates.map((candidate) => candidate.surfaceId)).size !== candidates.length) fail('physical identities must be unique');
  const dispositions = new Set(['PHYSICAL', 'SUBSUMED', 'SUPPORT_ONLY', 'ARCHIVED', 'EXTERNAL']);
  const phases = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
  for (const candidate of candidates) {
    if (!dispositions.has(candidate.disposition)) fail(`${candidate.surfaceId}: unsupported physical disposition ${candidate.disposition}`);
    for (const ref of [candidate.manifestPath, candidate.publicBoundaryRef]) {
      if (!fs.existsSync(path.join(root, ref))) fail(`${candidate.surfaceId}: missing source ref ${ref}`);
    }
    for (const phase of phases) {
      const cell = candidate.phaseApplicability?.[phase];
      if (!cell || !cell.disposition || !cell.rationale) fail(`${candidate.surfaceId}: ${phase} applicability cell is incomplete`);
      const refs = [cell.authorityRef, cell.operationAuthorityRef, ...(cell.authorityRefs ?? [])].filter(Boolean);
      for (const ref of refs) if (!fs.existsSync(path.join(root, ref))) fail(`${candidate.surfaceId}: ${phase} has missing authority ref ${ref}`);
    }
  }
  const crosswalk = topology.consumerCrosswalk ?? [];
  if (crosswalk.length !== 17 || new Set(crosswalk.map((x) => x.surfaceId)).size !== 17) fail('consumer crosswalk must contain exactly 17 unique surfaces');
  const registryIds = new Set([...source('.product-experience/surface-registry.yaml').matchAll(/^\s+- surfaceId:\s*([^\s]+)/gm)].map((m) => m[1]));
  const crosswalkIds = new Set(crosswalk.map((x) => x.surfaceId));
  if (registryIds.size !== 17 || [...registryIds].some((id) => !crosswalkIds.has(id)) || [...crosswalkIds].some((id) => !registryIds.has(id))) fail('crosswalk must match every surface-registry identity in both directions');
  const bindingStates = new Set(['PHYSICAL', 'CONTRACT_ONLY', 'HOST_DEPENDENT', 'ARCHIVED']);
  const reverse = new Map(candidates.map((c) => [c.surfaceId, []]));
  for (const consumer of crosswalk) {
    if (!bindingStates.has(consumer.bindingState) || !consumer.statusReason) fail(`${consumer.surfaceId}: binding state and reason are required`);
    if (!registryIds.has(consumer.surfaceId)) fail(`${consumer.surfaceId}: not present in surface-registry.yaml`);
    for (const ref of consumer.sourceContracts ?? []) if (!fs.existsSync(path.join(root, ref))) fail(`${consumer.surfaceId}: missing contract source ${ref}`);
    for (const ref of consumer.physicalRefs) {
      if (!byId.has(ref)) fail(`${consumer.surfaceId}: unknown physical ref ${ref}`);
      else reverse.get(ref).push(consumer.surfaceId);
    }
    if (consumer.bindingState !== 'ARCHIVED' && consumer.physicalRefs.length === 0) fail(`${consumer.surfaceId}: active consumer needs an explicit physical or contract binding`);
  }
  for (const candidate of candidates) {
    const expected = [...(reverse.get(candidate.surfaceId) ?? [])].sort();
    const recorded = [...(candidate.consumerSurfaceRefs ?? [])].sort();
    if (JSON.stringify(expected) !== JSON.stringify(recorded)) fail(`${candidate.surfaceId}: physical-to-consumer reverse refs do not match the crosswalk`);
    if (!['MAPPED', 'NO_DIRECT_CONSUMER_SUPPORT_ONLY'].includes(candidate.consumerMappingState)) fail(`${candidate.surfaceId}: explicit consumer mapping state is required`);
    if (expected.length === 0 && candidate.consumerMappingState !== 'NO_DIRECT_CONSUMER_SUPPORT_ONLY') fail(`${candidate.surfaceId}: missing consumer must be explicitly support-only`);
  }
  const compositions = topology.compositions ?? [];
  const compositionById = new Map(compositions.map((x) => [x.surfaceId, x]));
  if (new Set(compositions.map((x) => x.surfaceId)).size !== compositions.length) fail('composition identities must be unique');
  for (const composition of compositions) {
    if (!composition.canonicalOwner || !composition.directMeaning || !composition.children?.length) fail(`${composition.surfaceId}: composition must state owner, direct meaning and children`);
    for (const phase of phases) {
      const cell = composition.phaseApplicability?.[phase];
      if (!cell?.disposition || !cell?.rationale) fail(`${composition.surfaceId}: ${phase} applicability cell is incomplete`);
      for (const ref of [cell.authorityRef, ...(cell.authorityRefs ?? [])].filter(Boolean)) {
        if (!fs.existsSync(path.join(root, ref))) fail(`${composition.surfaceId}: ${phase} has missing authority ref ${ref}`);
      }
    }
    for (const child of composition.children ?? []) if (!byId.has(child) && !compositionById.has(child)) fail(`${composition.surfaceId}: unknown child ${child}`);
  }
  const roots = compositions.filter((x) => x.kind === 'REPOSITORY_ROOT');
  if (roots.length !== 1) fail('exactly one repository root composition is required');
  const reachable = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) { fail(`containment cycle reaches ${id}`); return; }
    if (reachable.has(id)) return;
    visiting.add(id);
    reachable.add(id);
    const node = compositionById.get(id);
    for (const child of node?.children ?? []) {
      if (compositionById.has(child)) visit(child);
      else if (byId.has(child)) reachable.add(child);
    }
    visiting.delete(id);
  };
  if (roots[0]) {
    visit(roots[0].surfaceId);
    for (const id of byId.keys()) if (!roots[0].children.includes(id) && !reachable.has(id)) fail(`orphan physical candidate ${id} has no containment path from repository root`);
    for (const item of [...byId.keys(), ...compositionById.keys()]) if (!reachable.has(item)) fail(`unreachable topology node ${item}`);
  }
  const sourceIds = new Set();
  for (const file of ['.product-experience/pdp-0-product-truth/capabilities.yaml', '.product-experience/pdp-0-product-truth/requirements.yaml', '.product-experience/pdp-0-product-truth/goals-jtbd.yaml', '.product-experience/pdp-1-domain-data/domain-objects.yaml', '.product-experience/pdp-1-domain-data/operations.yaml', '.product-experience/pdp-3-product-experience/screen-registry.yaml', '.product-experience/pdp-3-product-experience/journey-registry.yaml']) {
    for (const id of ids(file)) sourceIds.add(id);
  }
  for (const node of [...candidates, ...compositions]) {
    const p0 = node.phaseApplicability?.['PDP-0'];
    for (const ref of [...(p0?.capabilityFamilyIds ?? []), ...(p0?.requirementIds ?? []), ...(p0?.capabilityIntentIds ?? []), ...(p0?.intentIds ?? [])]) if (!sourceIds.has(ref)) fail(`${node.surfaceId}: PDP-0 reference is not in canonical source: ${ref}`);
    const p3 = node.phaseApplicability?.['PDP-3'];
    for (const ref of [...(p3?.screenIds ?? []), ...(p3?.journeyIds ?? [])]) if (!sourceIds.has(ref)) fail(`${node.surfaceId}: PDP-3 experience ref is not in canonical source: ${ref}`);
    const p1 = node.phaseApplicability?.['PDP-1'];
    for (const ref of [...(p1?.operationIds ?? []), ...(p1?.domainObjectIds ?? [])]) if (!sourceIds.has(ref)) fail(`${node.surfaceId}: PDP-1 ref is not in canonical source: ${ref}`);
  }
  for (const entry of topology.additionalBoundarySources ?? []) {
    const ref = entry.sourcePath.split('#')[0];
    if (!fs.existsSync(path.join(root, ref))) fail(`additional boundary source is missing: ${entry.sourcePath}`);
    if (!registryIds.has(entry.consumerSurfaceId)) fail(`additional boundary source has unknown consumer: ${entry.consumerSurfaceId}`);
    if (!entry.binding || !entry.kind) fail(`additional boundary source lacks an explicit binding decision: ${entry.sourcePath}`);
  }
  const archivedPaths = new Set(topology.archivedManifestLocations.map((x) => x.path));
  if (archivedPaths.size !== 4 || [...archivedPaths].some((p) => !fs.existsSync(path.join(root, p)))) fail('four archived desktop manifests must be accounted for with extant source paths');
  if (topology.lifecycleContractStatus?.status !== 'PARTIAL_PUBLIC_CONTRACT_AVAILABLE') fail('Lifecycle public-contract audit state must reflect available generic APIs');
  if (topology.lifecycleContractStatus?.hierarchicalMediaContractStatus !== 'UPSTREAM_NOT_AVAILABLE') fail('missing Media hierarchical contract must remain explicitly UPSTREAM_NOT_AVAILABLE');
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
  const errors = validateTopology(topology);
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Media physical topology valid: ${topology.manifestCandidates.length} manifest candidates, ${topology.consumerCrosswalk.length} consumers, ${topology.compositions.length} compositions.`);
  }
}
