import fs from 'node:fs';
import crypto from 'node:crypto';
import yaml from 'yaml';
import { validateBuildWorkPackageProjection } from './lib/media-build-work-packages-validation.mjs';
import { buildMediaBuildSurfaceHandoff } from './lib/media-build-work-package-surfaces.mjs';
import { buildSemanticSourceJoins } from './lib/media-build-semantic-source-joins.mjs';
import { pdp0PhaseScopedSourcePins } from './report-media-pdp-readiness.mjs';

const root = process.cwd();
const read = p => fs.readFileSync(`${root}/${p}`, 'utf8');
const json = p => JSON.parse(read(p));
const shaCache = new Map();
const sha = p => {
  if (!shaCache.has(p)) shaCache.set(p, crypto.createHash('sha256').update(fs.readFileSync(`${root}/${p}`)).digest('hex'));
  return shaCache.get(p);
};
const planPath = 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md';
const tracePath = 'docs/implementation/MEDIA-BUILD-IDENTITY-TRACE.v1.json';
const topologyPath = '.product-experience/surfaces/media-physical-topology.v1.json';
const topology = json(topologyPath);
const trace = json(tracePath);
const purposePath = '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml';
const channelPath = '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml';
const surfaceRegistryPath = '.product-experience/surface-registry.yaml';
const purpose = yaml.parse(read(purposePath));
const channel = yaml.parse(read(channelPath));
const surfaceRegistry = yaml.parse(read(surfaceRegistryPath)).surfaces;
const errors = [];
function unique(values, label) {
  const seen = new Set();
  for (const v of values) {
    if (!v || seen.has(v)) errors.push(`${label}: duplicate or missing identity ${v ?? '<empty>'}`);
    seen.add(v);
  }
}
const rows = trace.traceRows;
const semanticBridge = buildSemanticSourceJoins({ root, traceRows: rows });
const joins = semanticBridge.rows;
const unresolvedBridgeRows = joins.filter(row => row.unresolvedSourceBlockers.length > 0);
unique(rows.map(r => `${r.phase}:${r.kind}:${r.id}`), 'trace identities');
if (rows.length !== 3189) errors.push(`expected 3189 trace rows, got ${rows.length}`);
const planText = read(planPath);
const headers = [...planText.matchAll(/^### (M-BLD-([FVLX]\d{2})) — (.+)$/gm)];
const packages = headers.map((m, i) => {
  const end = headers[i + 1]?.index ?? planText.length;
  const section = planText.slice(m.index, end);
  const depLine = section.match(/\*\*Dependencies:\*\*([^\n]+)/)?.[1] ?? '';
  const dependencies = [...depLine.matchAll(/M-BLD-[FVLX]\d{2}/g)].map(x => x[0]);
  return { id: m[1], title: m[3], dependencies, section };
});
unique(packages.map(p => p.id), 'package IDs');
if (packages.length !== 50) errors.push(`expected 50 packages, got ${packages.length}`);
const packageFamilyLanes = new Map();
for (const pkg of packages) {
  const family = pkg.id.match(/^M-BLD-([FVLX])\d{2}$/)?.[1];
  if (!family) {
    errors.push(`${pkg.id}: package ID does not identify an approved package family lane`);
    continue;
  }
  if (!packageFamilyLanes.has(family)) packageFamilyLanes.set(family, []);
  packageFamilyLanes.get(family).push(pkg.id);
}
const wipPolicy = {
  source: { path: planPath, section: '11B' },
  laneModel: 'existing-package-family-prefix',
  limits: {
    maxSimultaneouslyEditedPackagesPerLane: 2,
    maxActiveChangeWritersPerSharedFileOrSchemaOwner: 1
  },
  lanes: [...packageFamilyLanes].map(([id, packageIds]) => ({ id, packageIds })),
  semantics: 'Policy limits only; this projection does not record staffing, active work, or readiness.'
};
const packageIds = new Set(packages.map(p => p.id));
for (const r of rows) {
  if (r.primaryPackageId !== 'N/A' && !packageIds.has(r.primaryPackageId)) errors.push(`${r.id}: unknown primary package ${r.primaryPackageId}`);
  if (r.primaryPackageId === 'N/A' && r.id !== 'media.surface.desktop-archive') errors.push(`${r.id}: N/A ownership lacks the explicit archived consumer disposition`);
}
for (const p of packages) for (const dep of p.dependencies) if (!packageIds.has(dep)) errors.push(`${p.id}: unknown dependency ${dep}`);
const visiting = new Set(); const visited = new Set();
function visit(id) { if (visiting.has(id)) { errors.push(`package dependency cycle at ${id}`); return; } if (visited.has(id)) return; visiting.add(id); for (const dep of packages.find(p => p.id === id)?.dependencies ?? []) visit(dep); visiting.delete(id); visited.add(id); }
for (const p of packages) visit(p.id);
unique(channel.edges.map(e => e.id), 'channel edges');
const candidates = topology.manifestCandidates;
const cross = topology.consumerCrosswalk;
const surfaceIds = [...candidates, ...topology.compositions, ...cross].map(x => x.surfaceId);
unique(surfaceIds, 'surface IDs');
const statusPaths = [0, 1, 2, 3].map(i => `docs/implementation/pdp-${i}-phase-dev-status.json`);
const matrixPaths = [0, 1, 2, 3].map(i => `docs/implementation/verification/pdp-38/pdp${i}-surface-phase-status-matrix.json`);
const statuses = statusPaths.map(p => {
  const x = json(p);
  return { path: p, status: x.status, outstandingDefinitionTaskIds: x.outstandingDefinitionTaskIds ?? x.remainingDevelopmentTaskIds ?? [] };
});
const phasePins = pdp0PhaseScopedSourcePins();
const materialSources = statusPaths.flatMap((p, i) => {
  const record = json(p);
  return Object.entries(record.sourceShaSet ?? {}).map(([selector, expectedSha256]) => {
    const currentSha256 = selector.includes('#') ? (i === 0 ? phasePins[selector] : undefined) : (fs.existsSync(`${root}/${selector}`) ? sha(selector) : undefined);
    return { phase: `PDP-${i}`, selector, expectedSha256, currentSha256: currentSha256 ?? null, status: currentSha256 === expectedSha256 ? 'CURRENT' : 'STALE_OR_UNSUPPORTED' };
  });
});
const staleMaterialSources = materialSources.filter(x => x.status !== 'CURRENT');
const matrixDocuments = matrixPaths.map(path => ({ path, matrix: json(path) }));
const matrices = matrixDocuments.map(({ path, matrix }) => {
  const ids = matrix.surfaces.map(x => x.surfaceId);
  if (ids.length !== 54 || new Set(ids).size !== 54 || matrix.campaign?.status !== 'DEV_COMPLETE' || matrix.phaseSourceCurrentness?.status !== 'CURRENT') throw new Error(`${path}: expected 54 unique CURRENT DEV_COMPLETE surface rows`);
  return { path, sha256: sha(path), rowCount: ids.length, surfaceIds: ids, phase: matrix.campaign.phase, sourceCurrentness: matrix.phaseSourceCurrentness.status, status: matrix.campaign.status };
});
const surfaces = buildMediaBuildSurfaceHandoff({ topology, surfaceRegistry, matrices: matrixDocuments });
const matrixBoundSurfaceIds = new Set(surfaces.filter(x => !x.matrixDelta).map(x => x.id));
for (const matrix of matrices) if (matrix.surfaceIds.some(id => !matrixBoundSurfaceIds.has(id)) || [...matrixBoundSurfaceIds].some(id => !matrix.surfaceIds.includes(id))) throw new Error(`${matrix.path}: surface membership differs from matrix-bound topology`);
const earlyRecordingJourneyIds = ['J-01', 'J-02', 'J-20', 'J-03'];
const earlyJourneySet = new Set(earlyRecordingJourneyIds);
const earlyJourneyContractPaths = channel.edges.filter(edge => earlyJourneySet.has(edge.journeyRef)).map(edge => edge.journeyContractRef);
const sourcePaths = [...new Set([planPath, tracePath, topologyPath, surfaceRegistryPath, '.product-experience/source-manifest.yaml', purposePath, channelPath, ...earlyJourneyContractPaths, ...semanticBridge.sourceFiles, ...statusPaths, ...matrixPaths])].sort();
const textField = (section, label) => section.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+(?:\\n(?!\\*\\*)[^\\n]+)*)`))?.[1]?.trim() ?? '';
const taskRows = packages.map(p => {
  const taskId = `${p.id}.T01`;
  const owned = joins.filter(r => r.primaryPackageId === p.id);
  const targetText = textField(p.section, 'Canonical source/target paths') || textField(p.section, 'Canonical source paths');
  const testsText = textField(p.section, 'Test layers / commands');
  const testIds = label => textField(p.section, label).split(/\n+/u)
    .map(line => line.match(/M-BLD-F\d+\.T\d+\.(?:POSITIVE|ADVERSARIAL)\.[A-Z0-9_.]+/u)?.[0])
    .filter(Boolean);
  const positiveTestIds = testIds('Positive test IDs');
  const adversarialTestIds = testIds('Adversarial test IDs');
  const acceptance = textField(p.section, 'Observable acceptance / completion evidence') || 'Package-specific acceptance details are absent from the plan section and remain unresolved.';
  const outcome = textField(p.section, 'Outcome & scope') || p.title;
  const owner = textField(p.section, 'Owner / exclusive write boundary') || 'Package owner role unresolved in source plan.';
  const risk = textField(p.section, 'Security/privacy/performance & external risk') || 'Package-specific risk constraints unresolved in source plan; apply repository security, privacy, performance, accessibility, and OSS policy.';
  const rollback = textField(p.section, 'Rollback/migration') || 'Rollback/fencing/cleanup boundary is not specified in source plan; define and review before execution.';
  return {
    id: taskId, packageId: p.id, title: p.title, status: 'ASSIGNED_UNVERIFIED', priority: 'PLAN_ORDERED', packageDependencyScope: 'FULL_PACKAGE',
    outcome, joinedSourceIdentities: owned.map(x => ({ phase: x.phase, kind: x.kind, id: x.identity, sourceRecordSelectors: x.sourceRecordSelectors, joins: x.joins, unresolvedSourceSlots: x.unresolvedSourceSlots, unresolvedSourceBlockers: x.unresolvedSourceBlockers })),
    ownership: { repository: 'samujjwal/ghatana-media', role: owner, moduleFileBoundary: targetText || 'Package-specific file boundary unresolved in source plan.', externalDependencies: p.dependencies.length ? p.dependencies : ['No package dependency declared; owner-specific external ABI/provider prerequisites remain unresolved.'] },
    fingerprints: { sourcePins: sourcePaths.map(path => ({ path, sha256: sha(path) })), binaryAbi: { status: 'UNBOUND', value: null, blocker: 'No binary ABI fingerprint is asserted by the plan projection.' } },
    predecessorTaskIds: [],
    actions: [`Implement the source-bounded outcome for ${p.id} in a PR-sized change; split further if the declared boundary spans independent owners.`],
    tests: {
      positiveTestIds: positiveTestIds.length ? positiveTestIds : [taskId + '.POSITIVE'],
      adversarialTestIds: adversarialTestIds.length ? adversarialTestIds : [taskId + '.ADVERSARIAL'],
      commands: testsText ? testsText.split(/\n+/).map(x => x.trim()).filter(Boolean) : ['Exact focused positive/adversarial commands are not declared; identify them before implementation.']
    },
    expectedResult: acceptance, finality: 'Build-local result only; no PDP closure, release qualification, or runtime admission is implied.',
    environmentPrerequisites: 'Package-specific environment/provider/ABI prerequisites are not fully enumerated in the plan section; resolve before execution.',
    actionableBlocker: 'Planning assignment is not implementation admission. Resolve source-current package prerequisites, owner authorization, and exact positive/adversarial checks before implementation.',
    rollbackFencingCleanup: rollback, constraints: risk,
    evidence: { refs: [planPath, tracePath, ...sourcePaths], sourceFingerprints: sourcePaths.map(path => ({ path, sha256: sha(path) })), evidenceStatus: 'PLANNING_RECEIPT_ONLY' },
    reviewerRole: 'Independent engineering reviewer', approverRole: 'Engineering lead and product/quality owner under lifecycle authority'
  };
});
const journeySourceScope = journeyIds => {
  const journeySet = new Set(journeyIds);
  const purposeRecords = purpose.records.filter(record => journeySet.has(record.journeyRef));
  const purposeIds = new Set(purposeRecords.map(record => record.id));
  const channelEdges = channel.edges.filter(edge => journeySet.has(edge.journeyRef));
  const channelEdgeIds = new Set(channelEdges.map(edge => edge.id));
  const scopedRows = joins.filter(row =>
    (row.phase === 'PDP-3' && row.kind === 'journey' && journeySet.has(row.identity)) ||
    (row.kind === 'journey-step-purpose' && purposeIds.has(row.identity)) ||
    (row.kind === 'journey-channel-edge' && channelEdgeIds.has(row.identity))
  );
  const sourceSelectors = [...new Set(scopedRows.flatMap(row => [
    ...(row.sourceRecordSelectors ?? []),
    ...Object.values(row.joins ?? {}).flat().map(edge => edge.targetSelector).filter(Boolean)
  ]))].sort();
  return {
    status: 'SOURCE_SCOPED_PLANNING_ONLY',
    journeyIds,
    purposeBindingIds: purposeRecords.map(record => record.id).sort(),
    channelEdgeIds: channelEdges.map(edge => edge.id).sort(),
    operationRefs: [...new Set(purposeRecords.flatMap(record => [
      ...(record.operationRefs ?? []), ...(record.actionExactOperationRefs ?? [])
    ]).concat(channelEdges.flatMap(edge => (edge.p1OperationBindings ?? []).map(binding => binding.operationRef))))].sort(),
    sourceIdentityKeys: scopedRows.map(row => `${row.phase}:${row.kind}:${row.identity}`).sort(),
    sourceSelectors,
    globalTraceBlockers: [...new Set(scopedRows.flatMap(row => row.unresolvedSourceBlockers ?? []))].sort()
  };
};
const earlyRecordingSourceScope = journeySourceScope(earlyRecordingJourneyIds);
const j03SourceScope = journeySourceScope(['J-03']);
const scopedJoinRows = scope => new Set(scope.sourceIdentityKeys);
const earlyRecordingRows = joins.filter(row => scopedJoinRows(earlyRecordingSourceScope).has(`${row.phase}:${row.kind}:${row.identity}`));
const j03Rows = joins.filter(row => scopedJoinRows(j03SourceScope).has(`${row.phase}:${row.kind}:${row.identity}`));
const f00Base = taskRows.find(x => x.packageId === 'M-BLD-F00');
const f00Tasks = [
  { ...f00Base, id: 'M-BLD-F00.T01', title: 'Source material pin and topology census', outcome: 'Compare all four PDP status sourceShaSet records to current bytes/projections, verify all four 54-row matrices, and census 29 physical, 7 composite/root, and 21 logical topology identities (54 matrix-bound plus the declared roster-reconciliation delta).', status: staleMaterialSources.length ? 'STALE_BLOCKED' : 'PLANNING_RECEIPT_ONLY', actionableBlocker: staleMaterialSources.length ? `Reconcile stale material source selectors before treating the current-source receipt as current: ${staleMaterialSources.map(x => x.phase + ':' + x.selector).join(', ')}` : f00Base.actionableBlocker, joinedSourceIdentities: materialSources.map(x => ({ phase: x.phase, selector: x.selector, expectedSha256: x.expectedSha256, currentSha256: x.currentSha256, status: x.status })), evidence: { matrixReceipts: matrices, topologyInputPaths: [topologyPath, '.product-experience/surface-registry.yaml', '.product-experience/source-manifest.yaml'], surfaceIds: surfaces.map(x => x.id), materialSourceCount: materialSources.length, sourcePins: sourcePaths.map(path => ({ path, sha256: sha(path) })) } },
  { ...f00Base, id: 'M-BLD-F00.T02', title: 'Relational PDP identity bridge', outcome: 'Bind each of the 3,189 trace identities only through source-declared P0 capability/requirement, P1 operation/guard/state, P2 component/action/source slots, and P3 purpose/channel/edge/view selectors; retain unresolved slots.', status: unresolvedBridgeRows.length ? 'INCOMPLETE_SOURCE_RELATIONS' : 'ASSIGNED_UNVERIFIED', sourceJoinCompletionStatus: unresolvedBridgeRows.length ? 'INCOMPLETE' : 'CURRENT', unresolvedIdentityCount: unresolvedBridgeRows.length, actionableBlocker: unresolvedBridgeRows.length ? `${unresolvedBridgeRows.length} identities retain unresolved source membership or cross-layer relation blockers; resolve only through exact owner-source selectors.` : f00Base.actionableBlocker, joinedSourceIdentities: joins.map(x => ({ phase: x.phase, kind: x.kind, id: x.identity, primaryPackageId: x.primaryPackageId, sourceRecordSelectors: x.sourceRecordSelectors, joins: x.joins, unresolvedSourceSlots: x.unresolvedSourceSlots, unresolvedSourceBlockers: x.unresolvedSourceBlockers })), predecessorTaskIds: ['M-BLD-F00.T01'], tests: { positiveTestIds: ['M-BLD-F00.T02.POSITIVE'], adversarialTestIds: ['M-BLD-F00.T02.WRONG_JOIN', 'M-BLD-F00.T02.MISSING_ID', 'M-BLD-F00.T02.DUPLICATE_EDGE'], commands: ['node --test tests/media-build-work-packages-generator.test.mjs', 'node scripts/generate-media-build-work-packages.mjs --check'] } },
  { ...f00Base, id: 'M-BLD-F00.T03', title: 'P2 slots, code symbols, package handoff and consumer census', outcome: 'Generate the complete 50-package handoff, all 57 topology surface identities (declared matrix-delta rows carried without phase status), and explicit source UI/code symbol slots without inventing symbols or N/A dispositions.', status: 'ASSIGNED_UNVERIFIED', joinedSourceIdentities: surfaces.map(x => ({ id: x.id, type: x.type, topologySelector: x.topologySelector, registryApplicability: x.registryApplicability, topologyBinding: x.topologyBinding, applicability: x.applicability })), predecessorTaskIds: ['M-BLD-F00.T01', 'M-BLD-F00.T02'], tests: { positiveTestIds: ['M-BLD-F00.T03.POSITIVE'], adversarialTestIds: ['M-BLD-F00.T03.INVALID_NA', 'M-BLD-F00.T03.STALE_PIN', 'M-BLD-F00.T03.PACKAGE_CYCLE'], commands: ['node --test tests/media-build-work-packages-generator.test.mjs', 'node scripts/generate-media-build-work-packages.mjs --check'] } }
].map(task => ({ ...task, actions: [`Complete ${task.title} as a planning-only, source-bound PR-sized change.`], expectedResult: task.title + ' recorded with exact source selectors and no runtime or closure claim.', actionableBlocker: 'Planning task evidence does not admit runtime implementation; any missing source relation stays explicitly unresolved.', finality: 'Planning receipt only; no PDP closure, release qualification, or runtime admission.', reviewerRole: 'Independent engineering reviewer', approverRole: 'Engineering lead and product/quality owner under lifecycle authority' }));
const l01Base = taskRows.find(x => x.packageId === 'M-BLD-L01');
const scopedL01Task = (taskId, title, predecessorTaskIds, outcome, expectedResult, environmentPrerequisites, tests) => ({
  ...l01Base,
  id: taskId,
  title,
  status: 'ASSIGNED_UNVERIFIED',
  packageDependencyScope: 'EARLY_SCOPED',
  prerequisiteBasis: `${planPath}#§5A early source-derived recording tasks`,
  predecessorTaskIds,
  outcome,
  joinedSourceIdentities: earlyRecordingRows.map(row => ({ phase: row.phase, kind: row.kind, id: row.identity, sourceRecordSelectors: row.sourceRecordSelectors, joins: row.joins, unresolvedSourceSlots: row.unresolvedSourceSlots, unresolvedSourceBlockers: row.unresolvedSourceBlockers })),
  sourceScope: earlyRecordingSourceScope,
  actions: [outcome],
  tests,
  expectedResult,
  environmentPrerequisites,
  actionableBlocker: 'Planning assignment only. Keep unresolved source links, owner-issued receipts, host/provider admission, capture permissions and independent film review explicit; do not infer implementation or approval.',
  evidence: { ...l01Base.evidence, refs: [...new Set([...(l01Base.evidence?.refs ?? []), planPath])], evidenceStatus: 'PLANNING_RECEIPT_ONLY' }
});
const l01Tasks = [
  scopedL01Task('M-BLD-L01.T01', 'PDP-source-derived first outcome recipe', ['M-BLD-F00.T01'], 'Derive the first source-authorized customer story, storyboard, ordered actions, semantic anchors, result and recovery cases from the exact J-01 → J-02 → J-20 → J-03 source subset; create the versioned declarative scenario schema and generator.', 'A source-pinned recipe projection covers the selected J-01/J-02/J-20/J-03 chain and rejects a missing P1 result, mismatched PDP-3 edge, unadmitted channel, duplicate story identity, or stale material hash. It remains a recipe, not a product action.', 'Use current PDP-0..3 material pins and the scoped source selectors in sourceScope. Exact missing P1 trace identities remain visible. No runtime channel or host is asserted.', { positiveTestIds: ['M-BLD-L01.T01.POSITIVE'], adversarialTestIds: ['M-BLD-L01.T01.MISSING_P1_RESULT', 'M-BLD-L01.T01.MISMATCHED_EDGE', 'M-BLD-L01.T01.UNADMITTED_CHANNEL', 'M-BLD-L01.T01.STALE_HASH'], commands: ['node --test tests/media-build-work-packages-generator.test.mjs'] }),
  scopedL01Task('M-BLD-L01.T02', 'Qualified product-neutral recorder substrate and first adapter', ['M-BLD-L01.T01'], 'Reuse the private Gharbatai product-neutral recorder exports, qualify a packed/local-source development consumer with dependency and license checks, and add a thin Media browser-capture adapter; support an authorized terminal channel only when admitted.', 'Capability/probe evidence matches source actions to actual frames or terminal receipts; no unauthorized effect, fake host, invalid source, secret logging, unsafe media, unlicensed narration, or nonexistent playback is claimed.', 'Proceed independently of full F10/F13 completion. Requires a local-source or packed recorder consumer, license/dependency checks, qualified host/provider and channel admission before recording, opaque credential references, and explicit browser/device permission boundaries.', { positiveTestIds: ['M-BLD-L01.T02.POSITIVE'], adversarialTestIds: ['M-BLD-L01.T02.UNAUTHORIZED_EFFECT', 'M-BLD-L01.T02.INVALID_SOURCE', 'M-BLD-L01.T02.SECRET_LOGGING', 'M-BLD-L01.T02.UNLICENSED_NARRATION'], commands: ['node --test tests/media-build-work-packages-generator.test.mjs'] }),
  scopedL01Task('M-BLD-L01.T03', 'First single-channel business-outcome readiness', ['M-BLD-V03.T02'], 'After the exact V03 single-channel task is actually functioning, verify the J-01/J-02/J-20/J-03 source and effect receipts for one admitted channel, including source digest, job/provider result, transcript timing, corrected caption draft CAS and immutable caption version.', 'BUSINESS-OUTCOME-READY is established only for one real source-authorized channel with owner-issued source/result/version/effect receipts and required negative/recovery observations. UNKNOWN, unavailable, fake STT or screenshot-only results remain blocked.', 'Requires M-BLD-V03.T02 actual execution, a canonical writer, genuine tenant rights, isolated seeded audio, real provider, one source-admitted channel and authoritative readback receipts. This does not require full V03, all V03 channels, V24, V29 or full L01 acceptance.', { positiveTestIds: ['M-BLD-L01.T03.POSITIVE'], adversarialTestIds: ['M-BLD-L01.T03.DENIAL', 'M-BLD-L01.T03.UNKNOWN', 'M-BLD-L01.T03.CONFLICTING_CAPTION_REVISION'], commands: ['node --test tests/media-build-work-packages-generator.test.mjs'] }),
  scopedL01Task('M-BLD-L01.T04', 'Record the first qualified business film', ['M-BLD-L01.T01', 'M-BLD-L01.T02', 'M-BLD-L01.T03'], 'As soon as T01–T03 and capture qualification pass, seed isolated demo-only data with lease-scoped teardown; execute configured semantic actions and capture real frames or terminal output, provenance, narration, captions, receipts and selective recapture evidence.', 'FIRST-FILM-RECORDED requires a real playable artifact and joined scene/receipt/digest manifest, rights/privacy review, and actual seeded cleanup. FIRST-FILM-APPROVED requires a separate film reviewer decision. Neither closes L01 or releases Media.', 'DEMO-READY = CURRENT_PDP_SOURCE ∧ BUSINESS-OUTCOME-READY ∧ CAPTURE-READY ∧ RIGHTS_FIXTURE_READY. Capture qualification, consent/licensing, actual host/provider, output readiness, privacy review and teardown evidence are external prerequisites and remain unverified here.', { positiveTestIds: ['M-BLD-L01.T04.REAL_CAPTURE'], adversarialTestIds: ['M-BLD-L01.T04.NO_TERMINAL_RECEIPT', 'M-BLD-L01.T04.RIGHTS_OR_PRIVACY_FAILURE', 'M-BLD-L01.T04.CLEANUP_FAILURE'], commands: ['node --test tests/media-build-work-packages-generator.test.mjs'] })
];
const l01FullTask = {
  ...l01Base,
  id: 'M-BLD-L01.T05',
  title: 'Full recorder orchestrator and applicable capture-adapter acceptance',
  packageDependencyScope: 'FULL_PACKAGE',
  prerequisiteBasis: `${planPath}#§7 M-BLD-L01 full-package dependencies; §5A T01–T04 are early scoped tasks only`,
  predecessorTaskIds: l01Tasks.map(task => task.id),
  actions: ['Complete the full M-BLD-L01 recorder package after all declared package dependencies and early scoped recording tasks pass.'],
  expectedResult: `${l01Base.expectedResult} Early §5A recording tasks do not waive full recorder modalities, channels, cases or package acceptance.`,
  environmentPrerequisites: 'All declared L01 package dependencies are complete, including F13, V01, V02, V20, V24 and V29, plus the full L01 recorder host/provider/channel and evidence prerequisites.',
  actionableBlocker: 'Full L01 acceptance remains unverified. Do not promote the early first-film subtasks to full package completion.',
  evidence: { ...l01Base.evidence, refs: [...new Set([...(l01Base.evidence?.refs ?? []), planPath])], evidenceStatus: 'PLANNING_RECEIPT_ONLY' }
};
const v03Base = taskRows.find(x => x.packageId === 'M-BLD-V03');
const v03SingleChannelTask = {
  ...v03Base,
  id: 'M-BLD-V03.T02',
  title: 'Generated §5A one-channel J-03 business-outcome subtask',
  taskOrigin: {
    type: 'GENERATED_SCOPED_DECOMPOSITION',
    canonicalPlanAuthored: false,
    source: planPath,
    section: '5A',
    rationale: '§5A requires a one-channel J-03 business-outcome implementation subtask for L01.T03; this generated dependency node does not assert a canonical plan-authored task ID.'
  },
  packageDependencyScope: 'EARLY_SCOPED',
  prerequisiteBasis: `${planPath}#§5A first selected J-01 → J-02 → J-20 → J-03 story; one-channel outcome subtask, not full V03 acceptance`,
  predecessorTaskIds: ['M-BLD-V02.T01', 'M-BLD-V20.T01', 'M-BLD-F08.T01', 'M-BLD-F11.T01', 'M-BLD-F09.T01'],
  outcome: 'Implement and verify the J-03 real business terminal on exactly one source-authorized, admitted channel, using the existing canonical Media writer, actual STT provider, source asset, transcript result, correction CAS and immutable caption version.',
  joinedSourceIdentities: j03Rows.map(row => ({ phase: row.phase, kind: row.kind, id: row.identity, sourceRecordSelectors: row.sourceRecordSelectors, joins: row.joins, unresolvedSourceSlots: row.unresolvedSourceSlots, unresolvedSourceBlockers: row.unresolvedSourceBlockers })),
  sourceScope: j03SourceScope,
  actions: ['Implement the J-03 first-channel business result with actual source/result/version/effect receipts; preserve denial, UNKNOWN, cancellation and correction-conflict behavior.'],
  tests: { positiveTestIds: ['M-BLD-V03.T02.POSITIVE'], adversarialTestIds: ['M-BLD-V03.T02.DENIAL', 'M-BLD-V03.T02.UNKNOWN', 'M-BLD-V03.T02.CANCELLATION', 'M-BLD-V03.T02.CORRECTION_CONFLICT'], commands: ['Run the exact affected J-03 implementation and channel checks after the real channel is selected.'] },
  expectedResult: 'BUSINESS-OUTCOME-READY for one real source-authorized channel only; the other J-03 channels and full V03 acceptance remain open.',
  environmentPrerequisites: 'Select exactly one source-authorized channel and satisfy only its real host/provider/writer admission and effect-readback requirements. No channel selection, provider qualification or runtime proof is asserted by this planning task.',
  actionableBlocker: 'ASSIGNED_UNVERIFIED planning subtask. Exact channel, canonical writer, provider qualification and real owner-issued result/effect receipts are not present in this generated plan.',
  evidence: { ...v03Base.evidence, refs: [...new Set([...(v03Base.evidence?.refs ?? []), planPath])], evidenceStatus: 'PLANNING_RECEIPT_ONLY' }
};
const v03FullTask = {
  ...v03Base,
  title: 'Full V03 transcription and all applicable channel acceptance',
  packageDependencyScope: 'FULL_PACKAGE',
  predecessorTaskIds: ['M-BLD-V03.T02'],
  expectedResult: `${v03Base.expectedResult} A single-channel §5A outcome does not complete full V03 or its other declared channels.`,
  evidence: { ...v03Base.evidence, refs: [...new Set([...(v03Base.evidence?.refs ?? []), planPath])], evidenceStatus: 'PLANNING_RECEIPT_ONLY' }
};
const v03Tasks = [v03FullTask, v03SingleChannelTask];
const projection = {
  schemaVersion: 'media.build-work-packages.v1',
  authority: 'Generated BUILD planning projection; not product or status authority.',
  stage: 'BUILD', phase: 'KDEV-STAGE-PLAN-IMPLEMENTATION', planningStatus: 'ASSIGNED_UNVERIFIED',
  wipPolicy,
  sourcePins: Object.fromEntries(sourcePaths.map(p => [p, sha(p)])),
  census: {
    traceIdentityCount: rows.length, packageCount: packages.length,
    surfaces: { physical: surfaces.filter(x => x.type === 'physical').length, compositions: surfaces.filter(x => x.type === 'composition').length, logical: surfaces.filter(x => x.type === 'logical').length, total: surfaces.length },
    pdpStatus: statuses, tracePopulations: trace.populations, matrixRows: matrices
  },
  packages: packages.map(p => ({ id: p.id, title: p.title, dependencies: p.dependencies, taskIds: p.id === 'M-BLD-F00' ? ['M-BLD-F00.T01', 'M-BLD-F00.T02', 'M-BLD-F00.T03'] : p.id === 'M-BLD-L01' ? [...l01Tasks.map(task => task.id), l01FullTask.id] : p.id === 'M-BLD-V03' ? v03Tasks.map(task => task.id) : [`${p.id}.T01`] })),
  tasks: [...taskRows.filter(t => !['M-BLD-F00', 'M-BLD-L01', 'M-BLD-V03'].includes(t.packageId)), ...f00Tasks, ...l01Tasks, l01FullTask, ...v03Tasks], surfaces, trace: joins,
  bridgeCensus: { identityCount: joins.length, unresolvedSourceMembershipCount: joins.filter(row => !row.sourceRecordSelectors.length).length, unresolvedCrossLayerRelationCount: joins.filter(row => row.unresolvedSourceSlots.length > 0).length, blockerCount: joins.reduce((sum, row) => sum + row.unresolvedSourceBlockers.length, 0), status: unresolvedBridgeRows.length ? 'INCOMPLETE' : 'SOURCE_RELATIONS_CURRENT' },
  materialSourceReceipt: { status: staleMaterialSources.length ? 'STALE_BLOCKED' : 'CURRENT', count: materialSources.length, staleCount: staleMaterialSources.length, records: materialSources }
};
const packageById = new Map(projection.packages.map(pkg => [pkg.id, pkg]));
const taskPackageId = new Map(projection.tasks.map(task => [task.id, task.packageId]));
const terminalTasksByPackage = new Map(projection.packages.map(pkg => {
  const internalPredecessors = new Set(projection.tasks
    .filter(task => task.packageId === pkg.id)
    .flatMap(task => task.predecessorTaskIds.filter(id => taskPackageId.get(id) === pkg.id)));
  return [pkg.id, pkg.taskIds.filter(taskId => !internalPredecessors.has(taskId))];
}));
for (const task of projection.tasks) {
  if (task.packageDependencyScope !== 'FULL_PACKAGE') continue;
  const pkg = packageById.get(task.packageId);
  task.predecessorTaskIds = [...new Set([
    ...task.predecessorTaskIds,
    ...pkg.dependencies.flatMap(dependencyId => terminalTasksByPackage.get(dependencyId) ?? [])
  ])];
}
const expectedPackageDependencies = Object.fromEntries(packages.map(pkg => [pkg.id, pkg.dependencies]));
if (errors.length) throw new Error(errors.join('\n'));
const identityKey = row => `${row.phase}:${row.kind}:${row.id}`;
const expectedTraceIdentityKeys = semanticBridge.authoritativeIdentityKeys;
const authoritativePopulations = Object.fromEntries(expectedTraceIdentityKeys.reduce((counts, key) => {
  const [phase, kind] = key.split(':');
  const category = `${phase}.${kind}`;
  counts.set(category, (counts.get(category) ?? 0) + 1);
  return counts;
}, new Map()));
const expectedJoinsByIdentity = new Map(joins.map(row => [`${row.phase}:${row.kind}:${row.identity}`, row.joins]));
const validNAIdentities = new Set(rows.filter(row => row.primaryPackageId === 'N/A' && row.id === 'media.surface.desktop-archive').map(identityKey));
const surfaceCounts = { physical: surfaces.filter(x => x.type === 'physical').length, compositions: surfaces.filter(x => x.type === 'composition').length, logical: surfaces.filter(x => x.type === 'logical').length, total: surfaces.length };
const validationErrors = validateBuildWorkPackageProjection(projection, { traceIdentityKeys: expectedTraceIdentityKeys, traceCount: expectedTraceIdentityKeys.length, tracePopulations: authoritativePopulations, packageIds: packages.map(x => x.id), packageDependencies: expectedPackageDependencies, wipPolicy, validNAIdentities, joinsByIdentity: expectedJoinsByIdentity, edgeIds: channel.edges.map(x => x.id), surfaceCounts, surfaceIds: [...matrixBoundSurfaceIds], surfaceRecords: surfaces, sourcePins: Object.fromEntries(sourcePaths.map(p => [p, sha(p)])), materialSources, matrixPaths });
if (validationErrors.length) throw new Error(validationErrors.join('\n'));
const output = 'docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json';
const text = JSON.stringify(projection, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(`${root}/${output}`) || read(output) !== text) { console.error(`${output} is stale; run generator`); process.exit(1); }
  console.log(`PASS ${output} is deterministic/current (${rows.length} identities)`);
} else {
  fs.writeFileSync(`${root}/${output}`, text);
  console.log(`Wrote ${output} (${rows.length} identities, ${packages.length} packages)`);
}
