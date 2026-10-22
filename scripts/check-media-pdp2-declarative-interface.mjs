// PDP-2-local validation for declarative-production presentation bindings.
// Reads only PDP-0/PDP-1 predecessors and PDP-2 source; it does not imply PDP-3,
// runtime, Explorer, owner acceptance, phase exit, or release admission.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const declarativePdp2Paths = {
  p0: '.product-experience/pdp-0-product-truth/requirements.yaml',
  p0Capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  p1: '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml',
  recorderP2: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
  sourceAuditReview: '.product-experience/pdp-2-design-interface-system/source-audit-interface-review.json',
};
export const pdp2AuditReviewInputPaths = {
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  p0Crosswalk: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  thirdPassCrosswalk: 'docs/implementation/observations/media-attached-third-pass-id-provenance-crosswalk-2026-10-18.json',
  taskCrosswalk: 'docs/implementation/observations/media-unified-source-task-and-experiment-crosswalk-2026-10-18.json',
};
const ids = Array.from({ length: 61 }, (_, i) => `MEDIA-DECL-P0-AC-${String(i + 1).padStart(3, '0')}`);
const groups = { ANIMATION: 17, SIMULATION: 22, TUTORPUTOR: 12, UNIFIED: 10 };
const surfaces = [
  'media.surface.recorder-orchestrator',
  'media.surface.capture-adapters',
  'media.surface.production-studio',
  'media.surface.interactive-demo-player',
];
const sameSet = (left, right) => Array.isArray(left) && new Set(left).size === left.length &&
  new Set(right).size === right.length && left.length === right.length && left.every(value => right.includes(value));

export function verifyPdp2DeclarativeInterface({ repoRoot = root, overrides = {} } = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  const docs = {};
  for (const [key, relative] of Object.entries(declarativePdp2Paths)) {
    const raw = Object.hasOwn(overrides, key) ? overrides[key] : fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const parsed = parseDocument(raw, { strict: true, uniqueKeys: true });
    if (parsed.errors.length) {
      for (const issue of parsed.errors) fail(`${key}: invalid or duplicate YAML: ${issue.message}`);
      continue;
    }
    try { docs[key] = parsed.toJS(); } catch (error) { fail(`${key}: invalid document shape: ${error.message}`); }
  }
  const inputs = {};
  for (const [key, relative] of Object.entries(pdp2AuditReviewInputPaths)) {
    const raw = Object.hasOwn(overrides, key) ? overrides[key] : fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    try { inputs[key] = JSON.parse(raw); }
    catch (error) { fail(`${key}: invalid JSON source: ${error.message}`); }
  }
  const p0 = docs.p0?.declarativeProductionProfile ?? {};
  const p0Capabilities = docs.p0Capabilities?.capabilities ?? [];
  const p1 = docs.p1 ?? {};
  const p2 = docs.p2?.declarativeProductionInterface ?? {};
  const recorder = docs.recorderP2 ?? {};
  const sourceAuditReview = docs.sourceAuditReview ?? {};
  const p0Rows = p0.acceptanceClauses ?? [];
  const p1Rows = p1.caseOperationBindings ?? [];
  const p2Rows = p2.caseInterfaceBindings ?? [];
  const p0ById = new Map(p0Rows.map(row => [row.id, row]));
  const p1ById = new Map(p1Rows.map(row => [row.caseId, row]));
  const p2ById = new Map(p2Rows.map(row => [row.caseId, row]));

  if (!sameSet(p0Rows.map(row => row.id), ids) || p0.additionalAcceptanceCaseCount !== 61)
    fail('PDP-0 predecessor must contain the exact 61 canonical declarative case identities');
  if (p1.denominator?.operationBindings !== 61 || !sameSet(p1Rows.map(row => row.caseId), ids))
    fail('PDP-1 predecessor must bind the exact 61 declarative cases');
  if (p2.caseCount !== 61 || !sameSet(p2Rows.map(row => row.caseId), ids))
    fail('PDP-2 must bind the exact 61 canonical declarative cases');
  if (!sameSet(p2.surfaces, surfaces)) fail('PDP-2 must preserve the exact four declarative surface identities');
  if (p2.existingManualStudioOperationKinds !== 52 ||
      recorder.manualOperationParity?.canonicalOperationCount !== 52 ||
      recorder.manualOperationParity?.operations?.length !== 52 ||
      p2.manualParitySource !== `${declarativePdp2Paths.recorderP2}#manualOperationParity`)
    fail('PDP-2 must bind exact existing 52-kind Studio manual-operation parity');

  for (const [group, count] of Object.entries(groups)) {
    if (p0Rows.filter(row => row.group === group).length !== count ||
        p1Rows.filter(row => row.group === group).length !== count ||
        p2Rows.filter(row => row.group === group).length !== count)
      fail(`${group}: PDP-0/PDP-1/PDP-2 group denominator must remain ${count}`);
  }

  for (const id of ids) {
    const r0 = p0ById.get(id), r1 = p1ById.get(id), r2 = p2ById.get(id);
    if (!r0 || !r1 || !r2) continue;
    if (r1.capabilityRef !== r0.capabilityLeafId || r2.capabilityRef !== r0.capabilityLeafId ||
        r1.surfaceId !== r0.surfaceId || r2.surfaceId !== r0.surfaceId ||
        r1.parentRequirementId !== r0.parentRequirementId)
      fail(`${id}: PDP-2 capability, requirement, or surface differs from exact P0/P1 predecessor`);
    if (!r1.canonicalOperationRef || r2.operationRef !== r1.canonicalOperationRef ||
        r2.sourceP1Binding !== `${declarativePdp2Paths.p1}#caseOperationBindings/@caseId=${id}`)
      fail(`${id}: PDP-2 operation/source binding must resolve to the exact P1 case row`);
    if (!r0.given || !r0.when || !r0.then || !r0.rejection ||
        !r2.statesRequired?.includes('OUTCOME_UNKNOWN') ||
        !r2.negative?.includes('no-fake-execution'))
      fail(`${id}: explicit positive, negative, unknown-finality, and no-fake-execution semantics are required`);
    if (r2.admission !== 'SCREEN_REUSE_PROPOSAL_NOT_RUNTIME_OR_EXPLORER_EVIDENCE')
      fail(`${id}: admission must remain a screen-reuse proposal without runtime or Explorer evidence`);
  }
  if (p2.status !== 'SOURCE_AUTHORED_PDP2_DEFINITION')
    fail('PDP-2 successor status must be source-current and distinct from phase DEV_COMPLETE');
  if (!p2.simulationGrammar?.stateRule?.includes('tStory') || !p2.simulationGrammar?.stateRule?.includes('tSim') ||
      !p2.simulationGrammar?.visualOutputs?.includes('never the reverse'))
    fail('PDP-2 must keep model state and presentation output authority distinct');
  if (!p2.tutorPutorIntegration?.evidenceOwner?.startsWith('TutorPutor only') ||
      !p2.headlessAndEmbeddedParity?.apiOnly?.includes('do not invent a real browser screen'))
    fail('PDP-2 must preserve TutorPutor evidence ownership and headless no-fake-screen boundary');

  const originalAuditRows = inputs.audit?.originalAudit?.inventory ?? [];
  const thirdPassRows = inputs.audit?.thirdPassAdditions ?? [];
  const expectedAuditRows = [...originalAuditRows.map(row => ({ ...row, sourcePartition: 'originalAudit' })),
    ...thirdPassRows.map(row => ({ ...row, sourcePartition: 'thirdPass' }))];
  const reviewRows = sourceAuditReview.sourceAuditRows ?? [];
  const p0CrosswalkRows = inputs.p0Crosswalk?.rows ?? [];
  const p0CrosswalkById = new Map(p0CrosswalkRows.map(row => [row.auditId, row]));
  const auditIds = expectedAuditRows.map(row => row.audit_id);
  const reviewIds = reviewRows.map(row => row.sourceAuditId);
  if (expectedAuditRows.length !== 501 || new Set(auditIds).size !== 501 ||
      reviewRows.length !== 501 || new Set(reviewIds).size !== 501 ||
      auditIds.some((id, index) => reviewIds[index] !== id))
    fail('PDP-2 source audit review must preserve the exact ordered 428 + 73 = 501 source IDs');
  if (p0CrosswalkRows.length !== 501 || auditIds.some(id => !p0CrosswalkById.has(id)))
    fail('PDP-2 source audit review requires the exact current PDP-0 crosswalk for all 501 IDs');

  const routeFamilies = sourceAuditReview.routeFamilies ?? [];
  const routesById = new Map(routeFamilies.map(route => [route.id, route]));
  const routeByDomain = new Map();
  for (const route of routeFamilies) {
    for (const code of route.codes ?? []) {
      if (routeByDomain.has(code)) fail(`PDP-2 audit route domain is duplicated: ${code}`);
      routeByDomain.set(code, route.id);
    }
    for (const workspaceKey of route.workspaces ?? []) {
      if (!recorder.productionStudioNavigation?.workspace?.includes(workspaceKey))
        fail(`${route.id}: route names a workspace outside the existing 13 Studio workspaces: ${workspaceKey}`);
    }
    for (const surfaceId of route.surfaces ?? []) {
      if (!recorder.surfaceInterfaces?.some(surface => surface.surfaceId === surfaceId))
        fail(`${route.id}: route names an undeclared PDP-2 surface: ${surfaceId}`);
    }
    for (const ref of route.contractRefs ?? []) {
      const relative = ref.split('#')[0];
      if (!fs.existsSync(path.join(repoRoot, relative))) fail(`${route.id}: missing PDP-2 contract source: ${ref}`);
    }
    if (!route.meaning) fail(`${route.id}: route disposition rationale is required`);
  }
  const sourceDomains = new Set(expectedAuditRows.map(row => row.domain_code));
  if (routeByDomain.size !== sourceDomains.size || [...sourceDomains].some(code => !routeByDomain.has(code)))
    fail('PDP-2 audit route families must classify every exact source domain code once');

  const recorderCaseToGroup = new Map();
  for (const group of recorder.pdp0AcceptanceCaseProjection?.groups ?? [])
    for (const caseId of group.cases ?? []) recorderCaseToGroup.set(caseId, group.id);
  const animationCaseIds = new Set(p2Rows.map(row => row.caseId));
  const deferredCapabilityIds = new Set(p0Capabilities.filter(row => row.scopeStatus === 'DEFERRED').map(row => row.id));
  const auditSourcePath = pdp2AuditReviewInputPaths.audit;
  const p0CrosswalkPath = pdp2AuditReviewInputPaths.p0Crosswalk;
  for (const [index, row] of reviewRows.entries()) {
    const source = expectedAuditRows[index];
    const p0Row = p0CrosswalkById.get(row.sourceAuditId);
    const partitionName = source.sourcePartition === 'originalAudit' ? 'originalAudit.inventory' : 'thirdPassAdditions';
    const expectedSourceRef = `${auditSourcePath}#${partitionName}/@audit_id=${row.sourceAuditId}`;
    const expectedP0Ref = `${p0CrosswalkPath}#rows/@auditId=${row.sourceAuditId}`;
    if (row.sourcePartition !== source.sourcePartition || row.domainCode !== source.domain_code ||
        row.sourceRef !== expectedSourceRef || row.pdp0CrosswalkRef !== expectedP0Ref)
      fail(`${row.sourceAuditId}: audit source identity, partition, domain, or PDP-0 trace is not exact`);
    const expectedRoute = routeByDomain.get(source.domain_code);
    if (!expectedRoute || row.routeFamilyId !== expectedRoute || !routesById.has(row.routeFamilyId))
      fail(`${row.sourceAuditId}: no exact PDP-2 route for source domain ${source.domain_code}`);

    const caseIds = (p0Row?.pdp0EvidenceRefs ?? [])
      .map(ref => ref.match(/@id=([^/]+)/)?.[1])
      .filter(id => id && /^MEDIA-(REC|DECL)-P0-AC-/.test(id) &&
        (recorderCaseToGroup.has(id) || animationCaseIds.has(id)));
    const expectedBindings = [...new Set(caseIds)].map(caseId => ({
      caseId,
      p2SourceRef: recorderCaseToGroup.has(caseId)
        ? `${declarativePdp2Paths.recorderP2}#pdp0AcceptanceCaseProjection/groups/@id=${recorderCaseToGroup.get(caseId)}/cases`
        : `${declarativePdp2Paths.p2}#declarativeProductionInterface/caseInterfaceBindings/@caseId=${caseId}`,
    }));
    const actualBindings = row.exactPdp2CaseBindings ?? [];
    if (JSON.stringify(actualBindings) !== JSON.stringify(expectedBindings))
      fail(`${row.sourceAuditId}: exact PDP-2 case refs must derive from current PDP-0 evidence and existing P2 case bindings`);

    const capabilityIds = (p0Row?.pdp0EvidenceRefs ?? [])
      .map(ref => ref.match(/capabilities\.yaml#capabilities\/@id=([^/]+)/)?.[1]).filter(Boolean);
    const expectedDeferred = [...new Set(capabilityIds.filter(id => deferredCapabilityIds.has(id)))].map(capabilityId => ({
      capabilityId,
      scopeRef: `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${capabilityId}`,
      decisionRef: `.product-experience/decision-log.md#${capabilityId === 'media.master.audio.creative-effect.apply' ? 'PXD-221' : 'PXD-220'}`,
    }));
    if (JSON.stringify(row.futureVersionCapabilityRefs ?? []) !== JSON.stringify(expectedDeferred))
      fail(`${row.sourceAuditId}: future-version subset must match current PDP-0 DEFERRED capability evidence exactly`);
    const mixedScopeDisposition = {
      'AUD-SPEC-015': 'PDP0_FUTURE_VERSION_SUBSCOPE_ONLY; RETAIN_CURRENT_PROJECT_VERSION_ROUTE',
      'AUD-DSP-003': 'PDP0_FUTURE_VERSION_SUBSCOPE_ONLY; RETAIN_CURRENT_MULTITRACK_AND_MIXER_ROUTE',
    };
    const expectedDisposition = mixedScopeDisposition[row.sourceAuditId] ?? (expectedDeferred.length
      ? 'RETAIN_EXISTING_ROUTE; ONLY_REFERENCED_DEFERRED_SUBSCOPE_UNAVAILABLE'
      : expectedBindings.length ? 'REUSE_EXACT_EXISTING_PDP2_CASE_BINDING' : 'REUSE_EXISTING_PDP2_DOMAIN_ROUTE');
    if (row.reviewDisposition !== expectedDisposition)
      fail(`${row.sourceAuditId}: PDP-2 review disposition disagrees with exact case and scope evidence`);
    const expectedCurrentPdp2Bindings = {
      'AUD-SPEC-015': [
        {
          scope: 'current-project-version-and-ordinary-edit-revision-presentation; does-not-admit-scene-patch-merge',
          contractRef: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#pdp0AcceptanceCaseProjection/groups/@id=media.recorder.p2.group.project.v1',
        },
        {
          scope: 'current-full-editing-timeline-and-inspector; does-not-admit-scene-patch-merge',
          contractRef: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#pdp0AcceptanceCaseProjection/groups/@id=media.recorder.p2.group.studio.v1',
        },
        {
          scope: 'one-canonical-project-revision-and-visible-stale-conflict; no-undeclared-same-field-merge',
          contractRef: '.product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml#revisionProjectionRule',
        },
      ],
      'AUD-DSP-003': [
        {
          scope: 'current-multitrack-timeline-and-source-time-presentation',
          contractRef: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#productionStudioPageCompositionContracts',
        },
        {
          scope: 'current-studio-gain-fade-and-mix-edit-parity; not-a-binding-for-deferred-creative-effects',
          contractRef: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#manualOperationParity/operations',
        },
        {
          scope: 'current-audio-mixer-presentation-for-gain-pan-routing-and-measured-state; action-binding-and-runtime-not-admitted',
          contractRef: '.product-experience/pdp-2-design-interface-system/component-contracts.yaml#components/@id=media.component.audio-mixer',
        },
      ],
    };
    if (expectedCurrentPdp2Bindings[row.sourceAuditId]) {
      if (JSON.stringify(row.currentPdp2Bindings) !== JSON.stringify(expectedCurrentPdp2Bindings[row.sourceAuditId]))
        fail(`${row.sourceAuditId}: mixed current and deferred PDP-0 scope must preserve its exact current PDP-2 route bindings`);
    } else if (row.currentPdp2Bindings !== undefined) {
      fail(`${row.sourceAuditId}: current PDP-2 scope bindings are reserved for source-backed mixed-scope dispositions`);
    }
    const expectedCurrentPdp2ScopeBoundary = {
      'AUD-SPEC-015': {
        currentMeaningRefs: [
          '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.version',
          '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-PROJECT/acceptanceCases/@id=MEDIA-REQ-CAP-PROJECT-AC-06',
        ],
        deferredMeaningRefs: [
          '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.scene.patch-merge',
          '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-PROJECT/acceptanceCases/@id=MEDIA-REQ-CAP-PROJECT-AC-07',
        ],
        boundary: 'Keep ordinary project-version, revision history, and current editing presentation. Show only scene-level patch/merge unavailable under PXD-220; the P2 bindings do not admit patch/merge.',
      },
      'AUD-DSP-003': {
        currentMeaningRefs: [
          '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.compose.multitrack-timeline',
          '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-COMPOSE/acceptanceCases/@id=MEDIA-REQ-CAP-COMPOSE-AC-04',
        ],
        deferredMeaningRefs: [
          '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.master.audio.creative-effect.apply',
          '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-MASTER-AUDIO/acceptanceCases/@id=MEDIA-REQ-CAP-MASTER-AUDIO-AC-03',
        ],
        boundary: 'Keep the existing multitrack-timeline and narration-mixer presentation. Only the creative-effect application extension is unavailable under PXD-221. The original extra acceptance clauses remain provenance-only as recorded by PDP-0 PXD-211; these P2 references do not bind an audio-pan or automation operation, claim measured export quality, or admit runtime behavior.',
      },
    };
    if (expectedCurrentPdp2ScopeBoundary[row.sourceAuditId]) {
      if (JSON.stringify(row.currentPdp2ScopeBoundary) !== JSON.stringify(expectedCurrentPdp2ScopeBoundary[row.sourceAuditId]))
        fail(`${row.sourceAuditId}: current/deferred PDP-0 scope boundary must preserve exact accepted and deferred meanings`);
    } else if (row.currentPdp2ScopeBoundary !== undefined) {
      fail(`${row.sourceAuditId}: explicit current/deferred meaning boundaries are limited to audited mixed-scope rows`);
    }
    if (!row.ownerReviewBoundary?.includes('no implementation/runtime/qualification/acceptance/closure/delivery claim'))
      fail(`${row.sourceAuditId}: PDP-2 audit disposition must preserve later-stage evidence boundaries`);
  }

  const thirdPassCrosswalk = inputs.thirdPassCrosswalk ?? {};
  const candidateRows = thirdPassCrosswalk.thirdPassTraceability ?? [];
  const candidateById = new Map(candidateRows.map(row => [row.sourceAuditId, row]));
  if (candidateRows.length !== 73 || sourceAuditReview.sourceDenominators?.thirdPassRowsWithCandidateCases !== 71 ||
      sourceAuditReview.sourceDenominators?.thirdPassRowsWithoutAtomicCandidateCases !== 2 ||
      JSON.stringify(sourceAuditReview.sourceDenominators?.thirdPassRowsWithoutAtomicCandidateIds) !==
        JSON.stringify(thirdPassCrosswalk.totals?.zeroCandidateSourceIds))
    fail('PDP-2 source review must preserve the exact 73-row non-normative crosswalk counts and zero-candidate IDs');
  for (const row of reviewRows.filter(item => item.sourcePartition === 'thirdPass')) {
    const candidate = candidateById.get(row.sourceAuditId);
    if (!candidate || row.thirdPassCandidateCrosswalkRef !==
        `${pdp2AuditReviewInputPaths.thirdPassCrosswalk}#thirdPassTraceability/@sourceAuditId=${row.sourceAuditId}` ||
        row.nonNormativeCandidateEvidence?.candidateFit !== candidate.candidateFit ||
        JSON.stringify(row.nonNormativeCandidateEvidence?.candidateP0AcceptanceCases) !==
          JSON.stringify(candidate.candidateP0AcceptanceCases) ||
        row.nonNormativeCandidateEvidence?.sourceAuthority !== candidate.sourceAuthority)
      fail(`${row.sourceAuditId}: the third-pass candidate crosswalk must remain exact and explicitly non-normative`);
  }

  const sourceTaskRows = sourceAuditReview.sourceTaskInventory?.rows ?? [];
  const taskItems = inputs.taskCrosswalk?.items ?? [];
  const taskIds = sourceTaskRows.map(row => row.sourceTaskId);
  if (taskItems.length !== 86 || sourceTaskRows.length !== 86 || new Set(taskIds).size !== 86 ||
      taskItems.some((item, index) => sourceTaskRows[index]?.sourceTaskId !== item.sourceTaskId ||
        sourceTaskRows[index]?.taskClass !== item.taskClass ||
        JSON.stringify(sourceTaskRows[index]?.stageClassification) !== JSON.stringify(item.stageClassification) ||
        sourceTaskRows[index]?.sourceRef !== `${item.originalSourcePath}#${item.originalSourceSection}`))
    fail('PDP-2 source review must preserve all 86 exact task/experiment IDs, classifications, and source refs');
  if (sourceTaskRows.filter(row => ['M-02', 'INV-03'].includes(row.sourceTaskId)).length !== 2 ||
      sourceTaskRows.find(row => row.sourceTaskId === 'M-02')?.p2Disposition !==
        'PDP2_WORKSPACE_ROUTE_AND_CHANNEL_GRAMMAR_DEFINED; PDP3_FLOW_TO_ACTION_AND_SCENARIO_BINDINGS_REMAIN_SEPARATE; BUILD_SOURCE_SYNC_AND_A11Y_VERIFICATION_NOT_ASSERTED' ||
      sourceTaskRows.find(row => row.sourceTaskId === 'INV-03')?.p2Disposition !==
        'PDP2_CONTROL_AND_CHANNEL_PARITY_GRAMMAR_DEFINED; PDP3_ACTION_TO_JOURNEY_SCREEN_BINDINGS_REMAIN_SEPARATE; BUILD_A11Y_MOBILE_DENIAL_VERIFICATION_NOT_ASSERTED' ||
      sourceTaskRows.find(row => row.sourceTaskId === 'M-02')?.p2ScopeRefs?.length !== 3 ||
      sourceTaskRows.find(row => row.sourceTaskId === 'INV-03')?.p2ScopeRefs?.length !== 3 ||
      JSON.stringify(sourceTaskRows.find(row => row.sourceTaskId === 'M-02')?.p2ScopeRefs) !== JSON.stringify([
        '.product-experience/pdp-2-design-interface-system/source-audit-interface-review.json#routeFamilies',
        '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#productionStudioPageCompositionContracts',
        '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#interfacesAndOperations',
      ]) ||
      JSON.stringify(sourceTaskRows.find(row => row.sourceTaskId === 'INV-03')?.p2ScopeRefs) !== JSON.stringify([
        '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#manualOperationParity',
        '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#interfacesAndOperations',
        '.product-experience/pdp-2-design-interface-system/cli-language.yaml',
      ]) ||
      !sourceTaskRows.find(row => row.sourceTaskId === 'M-02')?.laterPhaseBoundary?.pdp3?.includes('not claim them complete') ||
      !sourceTaskRows.find(row => row.sourceTaskId === 'M-02')?.laterPhaseBoundary?.build?.includes('no test or conformance result is claimed') ||
      !sourceTaskRows.find(row => row.sourceTaskId === 'INV-03')?.laterPhaseBoundary?.pdp3?.includes('does not claim them complete') ||
      !sourceTaskRows.find(row => row.sourceTaskId === 'INV-03')?.laterPhaseBoundary?.build?.includes('no test or conformance result is claimed'))
    fail('PDP-2 task review must scope M-02/INV-03 definitions separately from PDP-3 flow binding and Build verification');
  if (sourceAuditReview.sourceDenominators?.originalAudit !== 428 ||
      sourceAuditReview.sourceDenominators?.thirdPassAudit !== 73 ||
      sourceAuditReview.sourceDenominators?.sourceAuditRows !== 501 ||
      sourceAuditReview.sourceDenominators?.sourceIdsUnique !== 501 ||
      sourceAuditReview.sourceDenominators?.sourceTaskRows !== 86)
    fail('PDP-2 source review denominator metadata must remain 428 + 73 = 501 and 86 planning/experiment rows');

  return { errors, stats: { p0Cases: p0Rows.length, p1Bindings: p1Rows.length, p2Bindings: p2Rows.length,
    surfaceCount: surfaces.length, manualEditKinds: recorder.manualOperationParity?.operations?.length ?? 0,
    sourceAuditRows: reviewRows.length, sourceAuditRouteFamilies: routeFamilies.length,
    sourceAuditTaskRows: sourceTaskRows.length } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyPdp2DeclarativeInterface();
  process.stdout.write(JSON.stringify({ status: result.errors.length ? 'FAIL' : 'PASS', ...result }, null, 2) + '\n');
  if (result.errors.length) process.exitCode = 1;
}
