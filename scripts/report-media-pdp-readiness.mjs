#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildMediaProductDefinitionResidualReport } from './lib/media-product-definition-residuals.mjs';
import { enumerateExpectedMediaObligations } from './lib/media-obligation-denominator-audit.mjs';

export const taskIds = [8, 11, 9, 10].flatMap((n, phase) => Array.from({length:n}, (_,i) => `P${phase}-${String(i+1).padStart(2,'0')}`));
export function validateTaskPopulation(tasks) {
  const ids = tasks.map(t => t.id);
  if (ids.length !== 38 || new Set(ids).size !== 38 || taskIds.some(id => !ids.includes(id))) throw new Error('Readiness must contain exactly the 38 mandated PDP task identities');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parseYaml=createRequire(path.resolve(root,'../ghatana-tools/package.json'))('yaml').parse;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
export function verificationCutChanged(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(file => before[file] !== after[file]).sort();
}
const suites = {
  'P0-01': ['tests/pdp-truth-domain.test.mjs', 'tests/pdp-truth-domain-schema-validation.test.mjs'],
  'P0-02': ['tests/pdp-truth-domain.test.mjs', 'tests/pdp-truth-domain-schema-validation.test.mjs', 'tests/media-measure-applicability-crosswalk.test.mjs', 'tests/pdp-truth-domain-output-producer-applicability.test.mjs', 'tests/pdp-truth-domain-nfr-measurement-methods.test.mjs'],
  'P0-04': ['tests/pdp-0-final.test.mjs', 'tests/media-product-definition-resolved-intents.test.mjs'],
  'P1-06': ['tests/media-typed-contract-bindings.test.mjs'],
  'P2-01': ['tests/pdp-2-tools-experience-language-contract.test.mjs', 'tests/pdp-2-experience-language-projection.test.mjs'],
  'P1-01': ['tests/pdp-truth-domain.test.mjs'],
  'P1-02': ['tests/media-state-machine-extraction.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp1-transition-guard-definition-evaluator.test.mjs'],
  'P1-03': ['tests/pdp-truth-domain.test.mjs'],
  'P1-09': ['tests/media-temporal-spatial-definition-model.test.mjs', 'tests/media-descriptor-definition-oracles.test.mjs'],
  'P2-05': ['tests/pdp-design-composition.test.mjs'],
  'P2-04': ['tests/media-ui-reuse-inventory.test.mjs', 'tests/pdp-design-reuse-disposition.test.mjs'],
  'P2-07': ['tests/pdp-design-interface-parity.test.mjs'],
  'P3-01': ['tests/pdp-experience-definition-mapping.test.mjs'],
  'P3-02': ['tests/pdp-3-screen-journey-crosslinks.test.mjs'],
  'P3-03': ['tests/pdp-experience-step-semantics.test.mjs'],
  'P3-04': ['tests/pdp-experience-action-inventory.test.mjs'],
};
// Direct task criteria must not inherit failures from unrelated phase work.
// Those broader diagnostics remain in the full integration verification.
const directTestNames = {
  'P0-01': 'P0 defines every capability leaf|all 14 existing-operation capability bindings',
  'P0-02': 'P0 defines every capability leaf|P0-06 enumerates exact capability applicability|all 448 canonical capability|all 101 input and 69 output|rational frame-rate|all 14 existing-operation|measure|applicability|output producer|recovery|recipe|NFR|performance method|missing method|SLO',
  'P0-04': 'P0-04|PDP-0 preserves exact collaborator|PDP-0 requirement trace targets',
  'P2-01': 'Tools public ExperienceLanguage|PDP-2 disclosure density|PDP-2 recovery and accessibility|PDP-2 projects exact owner',
};
const implementationScopes = {
  'P1-01': 'Canonical identity and tenant-scoped relationship definitions; source-only observations remain distinguished. Persistence and independent acceptance are not established by these tests.',
  'P1-02': 'Source state meanings and owner-defined guard/transition semantics. Definition checks do not establish runtime crash, delivery, retry or cancellation qualification.',
  'P1-03': 'Exact owner-defined operation slices and the action-to-operation disposition census. Unbound operations remain open; a complete inventory is not a complete operation contract.',
  'P1-09': 'Exact rational timebase, sample-boundary, distinct pixel-center/boundary and selected SI conversion definitions; typed technical descriptors, VFR maps, display aspect and fidelity/provenance requirements with negative cases. Legacy wire alignment, metadata capture and scientific specialist acceptance remain open.',
  'P2-05': 'All selected central composition links resolve and reject invalid grammar references; rendered instances and independent conformance remain unaccepted.',
  'P2-04': 'All 31 component families have exact public-export candidate or contract-only dispositions. Source exports are not independent reuse, accessibility, package-owner or visual acceptance.',
  'P2-07': 'Interface identity inventory and bounded non-operation dispositions; no cross-channel semantic equivalence or runtime admission inferred.',
  'P3-01': 'Typed source-to-public candidate mapping with fail-closed action semantics; remaining field blockers are reported separately.',
  'P3-02': 'Exact screen registry, source contract and composition references. Complete state, authority, recovery and independent screen acceptance remain open.',
  'P3-03': 'Ordered journey step action/definition semantics; unbound canonical relationships and scenario acceptance remain open.',
  'P3-04': 'All action roles and typed owner-definition source envelopes; classification does not admit unbound consequential effects.',
};
export function buildReadiness({audit, residual, verification = {}, mainSha, fingerprints, definitionCensus = null, sourceWorkingTree = null, definitionCriterionReviews = {}}) {
  const tasks = audit.tasks.filter(t => taskIds.includes(t.id)).map(t => {
    const ownerReview=definitionCriterionReviews[t.id];
    const reviewedDefinition=ownerReview?.status==='APPROVED_DIRECT_DEFINITION_CRITERION' && ownerReview?.sourceCutCurrent===true;
    const knownMet = t.id === 'P0-04' || t.ledgerStatus === 'complete' || reviewedDefinition;
    const check = verification[t.id];
    const verified = knownMet && check?.status === 'PASS';
    return {
      id:t.id, title:t.title, originalLedgerStatus:t.ledgerStatus,
      originalFullTaskDone: t.ledgerStatus === 'complete',
      taskSpecificSourceDone: verified ? 'VERIFIED_IN_CURRENT_SOURCE' : knownMet ? 'PRIOR_SOURCE_AUDIT_MET_REVALIDATION_REQUIRED' : 'NOT_ESTABLISHED',
      definitionCriterionSatisfied:verified,
      definitionCriterionOwnerReview:ownerReview ?? null,
      dependencyReady: t.unmetPlanDependencies?.length ? 'NOT_ESTABLISHED' : 'PRIOR_AUDIT_NO_UNMET_DEPENDENCY_IDENTIFIED',
      independentOrPublisherAccepted:'NOT_EVALUATED', independentReviewAccepted:'NOT_EVALUATED',
      nativePhaseProofCurrent:'NOT_EVALUATED', LifecyclePhaseReceiptCurrent:'NOT_EVALUATED',
      overallDone:t.ledgerStatus,
      taskSpecificDoneClause:t.taskSpecificDoneClause,
      dependencies:t.planDependencies,
      previousAuditAssessment:t.assessment,
      previousAuditResiduals:t.unmetPredicates,
      priorEvidenceSources:t.evidenceSources,
      verification: check ?? {status:'NOT_RUN'},
      currentImplementationEvidence: implementationScopes[t.id] ? {
        scope:implementationScopes[t.id],
        sourceTests:check?.status ?? 'NOT_RUN',
        wholeTaskCriterionEstablished:false,
        acceptance:'NOT_CLAIMED',
      } : null,
    };
  });
  validateTaskPopulation(tasks);
  return {
    schemaVersion:'media.pdp-38-readiness.v1', mainSha, sourceWorkingTree,
    authority:'Diagnostic scope overlay. Original ledger and independent/Lifecycle authorities are unchanged. Previous audit residuals are historical, not a live semantic census.',
    taskCount:38, sourceFingerprints:fingerprints, authoredOwnerDefinitionCensus:definitionCensus, tasks,
    phases:[0,1,2,3].map(p => ({id:`PDP-${p}`,definition:'INCOMPLETE',sourceValidation:'SEE_VERIFICATION_RECORDS',semanticAcceptance:'NOT_ESTABLISHED',independentReview:'NOT_EVALUATED',proofAdmission:'NOT_EVALUATED',lifecycleCurrent:'NOT_EVALUATED'})),
    currentCounters:{
      capabilityLeaves:residual.capabilityCoverage.leafCount,
      historicalUnresolvedCapabilityTargets:residual.capabilityCoverage.unresolvedCount,
      authoredCapabilityContractRecords:definitionCensus?.capabilityDefinitionCollections?.records?.count ?? null,
      historicalMigrationSemanticUnresolved:residual.migrationSemantics.unresolvedCount,
      historicalMigrationMixed:residual.migrationSemantics.mixedRequiresDecompositionCount,
      interfaceIdentities:residual.operationParity.totalObservedIdentities,
      interfaceUnresolved:residual.operationParity.unresolvedIdentityCount,
      acceptedInterfaceBindings:residual.operationParity.acceptedBindingCount,
      designGates:residual.designConformance.gateCount,
      designOpenGates:residual.designConformance.openGateCount,
      screens:residual.productExperience.screenViewCount, journeys:residual.productExperience.journeyCount,
      steps:residual.productExperience.stepCount,
      stepsWithoutDirectActionRef:residual.productExperience.stepsWithoutActionBindings,
      unresolvedCurrentStepBindingRoles:residual.productExperience.journeyTrace?.currentStepBindingObservation?.actionDispositionCounts?.unresolvedStepActionBinding ?? null,
      projectionBlockers:Object.fromEntries(residual.projections.map(p=>[p.phase,p.unresolvedFieldCount])),
      obligations:residual.lifecycle.obligationCount,
      sourceEnumeratedObligations:definitionCensus?.lifecycleSourceEnumeration?.count ?? null,
      persistedObligationPopulationCountMatchesSource:definitionCensus?.lifecycleSourceEnumeration ? residual.lifecycle.obligationCount===definitionCensus.lifecycleSourceEnumeration.count && !definitionCensus.lifecycleSourceEnumeration.issues.length : null,
      obligationsWithoutCases:residual.lifecycle.obligationsWithoutCaseIds,
      localReceiptRecords:residual.lifecycle.localReceiptRecordCount,
      authoritativeReceiptCount:residual.lifecycle.receiptEvaluation.authoritativeReceiptCount,
      currentness:residual.lifecycle.currentnessEvaluation,
    }, diagnostics:residual.diagnostics,
  };
}
export function buildCurrentDefinitionCensus(repositoryRoot) {
 const read=(file)=>parseYaml(fs.readFileSync(path.join(repositoryRoot,'.product-experience',file),'utf8'));
 const domain=read('pdp-1-domain-data/domain-objects.yaml');
 const states=read('pdp-1-domain-data/states.yaml');
 const transitions=read('pdp-1-domain-data/transitions.yaml');
 const operations=read('pdp-1-domain-data/operations.yaml');
 const events=read('pdp-1-domain-data/events.yaml');
 const migration=read('pdp-0-product-truth/migration-semantics-review.yaml');
 const components=read('pdp-2-design-interface-system/component-contracts.yaml');
 const componentTypes=read('pdp-2-design-interface-system/component-value-types.yaml');
 const composition=read('pdp-2-design-interface-system/gui/composition-validation-grammar.yaml');
 const taxonomy=read('pdp-3-product-experience/public-effect-finality-taxonomy.yaml');
 const ownerRecords=operations.ownerDefinedOperationContracts?.records ?? [];
 const shapes=ownerRecords.filter(r=>r.requestSchema?.additionalProperties===false && r.resultSchema);
 const capabilityContracts=operations.capabilityOperationContracts ?? {};
 const contractCollections=Object.fromEntries(['records','families','bounds','inputPayloadSchemas','outputPayloadSchemas']
   .map(collection=>[collection,capabilityContracts[collection] ?? []]));
 const duplicateIds=records=>records.map(r=>r.id).filter((id,i,ids)=>ids.indexOf(id)!==i);
 const enumeration=enumerateExpectedMediaObligations({root:repositoryRoot,parseYaml});
 return {
   boundary:'Structural source census only; an exact ID or schema presence does not establish semantic completeness, interface equivalence, qualified behavior or acceptance.',
   domainObjectRecords:domain.objects?.length ?? 0,
   historicStateMachineRecords:states.stateMachines?.length ?? 0,
   historicTransitionRecords:transitions.transitionRecords?.length ?? 0,
   additiveOwnerTransitionRecords:transitions.ownerDefinedTransitionRecords?.length ?? 0,
   ownerDefinedOperationRecords:ownerRecords.length,
   ownerOperationRecordsWithClosedRequestAndResultShape:shapes.length,
   ownerOperationRecordsMissingClosedRequestOrResultShape:ownerRecords.filter(r=>!shapes.includes(r)).map(r=>r.id),
   capabilityDefinitionCollections:Object.fromEntries(Object.entries(contractCollections).map(([collection,records])=>[collection,{
     count:records.length,missingIds:records.filter(r=>typeof r.id!=='string'||!r.id).length,duplicateIds:duplicateIds(records),
   }])),
   eventContractRecords:events.ownerEventContracts?.records?.length ?? 0,
   localNotificationContractRecords:events.ownerEventContracts?.notificationRecords?.length ?? 0,
   designDefinitionCollections:{
     componentFamilies:components.components?.length ?? 0,
     typedComponentDefinitions:components.components?.filter(r=>r.typedDefinition)?.length ?? 0,
     normativeValueTypes:componentTypes.normativeTypeRecords?.length ?? 0,
     normativeCompositionRules:composition.normativeRuleRecords?.length ?? 0,
     semanticAcceptance:'NOT_ESTABLISHED_BY_THIS_CENSUS',
   },
   effectFinalityDefinitionRecords:taxonomy.records?.length ?? 0,
   lifecycleSourceEnumeration:{count:enumeration.records.length,issues:enumeration.issues,
     boundary:'Current normative source enumeration; persisted Lifecycle inputs must be regenerated and checked after source review. This is not accepted evidence or a phase receipt.'},
   migrationClaimReconciliation: migration.pdp38ClaimReconciliation ? Object.fromEntries([
     'currentClaimRecordCount','currentClaimUnitCount','sourceOwnerRoutingCount',
     'semanticParityVerifiedClaimUnitCount','candidateTargetPendingSemanticParityCount',
     'nonNormativeSourceMetadataClaimUnitCount','sourcePinDisposition','acceptanceEffect',
   ].map(field=>[field,migration.pdp38ClaimReconciliation[field] ?? null])) : null,
   operationSemanticCompleteness:'NOT_ESTABLISHED_BY_THIS_CENSUS',
   scientificQualification:'NOT_EVALUATED',
 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if(args.some(a=>!['--verify','--write'].includes(a) && !a.startsWith('--verify-tasks='))) throw new Error('Usage: report-media-pdp-readiness.mjs [--verify] [--verify-tasks=P0-01,P0-02,...] [--write]');
  const selectedTasksArg=args.find(a=>a.startsWith('--verify-tasks='));
  const selectedTasks=selectedTasksArg ? selectedTasksArg.slice('--verify-tasks='.length).split(',') : Object.keys(suites);
  if(selectedTasks.some(id=>!Object.hasOwn(suites,id)) || new Set(selectedTasks).size!==selectedTasks.length) throw new Error('Verification tasks must name distinct configured PDP suites');
  if(selectedTasksArg && !args.includes('--verify')) throw new Error('--verify-tasks requires --verify');
  const auditPath='docs/implementation/media-task-completion-blocker-report-2026-10-08.json';
  const audit=JSON.parse(fs.readFileSync(path.join(root,auditPath),'utf8'));
  const sourceCut = (testFiles) => Object.fromEntries([...new Set([...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.product-experience', 'scripts', 'config/closure', 'libs/media-experience-simulation'], {cwd:root,encoding:'utf8'})
    .trim().split('\n'), ...testFiles])].filter(file => file && fs.existsSync(path.join(root,file)) && fs.statSync(path.join(root,file)).isFile()).map(file => [file,digest(file)]));
  const verification = {};
  if(args.includes('--verify')) for(const [id, files] of Object.entries(suites).filter(([id])=>selectedTasks.includes(id))) {
    const missing=files.filter(f=>!fs.existsSync(path.join(root,f)));
    if(missing.length) {verification[id]={status:'NOT_RUN',reason:`Missing test sources: ${missing.join(', ')}`};continue;}
    const testArgs=['--test', ...(directTestNames[id] ? [`--test-name-pattern=${directTestNames[id]}`] : []), ...files];
    const before = sourceCut(files);
    const result=spawnSync(process.execPath,testArgs,{cwd:root,encoding:'utf8'});
    const changedSources = verificationCutChanged(before, sourceCut(files));
    verification[id]={status:result.status===0?'PASS':'FAIL',command:`node ${testArgs.map(arg=>arg.includes(' ')?JSON.stringify(arg):arg).join(' ')}`,exitCode:result.status,
      testScope:directTestNames[id] ? 'Exact bounded task-specific source criteria; broader phase diagnostics are separate' : 'Bounded implementation assertions; no whole-task completion inferred',
      outputSha256:crypto.createHash('sha256').update((result.stdout??'')+(result.stderr??'')).digest('hex'),testSourceFingerprints:Object.fromEntries(files.map(f=>[f,digest(f)]))};
    verification[id].sourceCut = {fingerprints:before, changedDuringVerification:changedSources};
    if (result.status===0 && changedSources.length) verification[id].status='PASS_ON_CHANGED_SOURCE_CUT_REVALIDATION_REQUIRED';
    fs.mkdirSync(path.join(root,'docs/implementation/verification/pdp-38'),{recursive:true});
    fs.writeFileSync(path.join(root,`docs/implementation/verification/pdp-38/${id}.log`),(result.stdout??'')+(result.stderr??''));
  }
  const currentSourceFiles=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','.product-experience','scripts','tests','config/closure','libs/media-experience-simulation'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const evidenceFiles=[...new Set([auditPath,...currentSourceFiles,...audit.tasks.filter(t=>taskIds.includes(t.id)).flatMap(t=>t.evidenceSources??[]).map(f=>f.split('#')[0])])].filter(f=>fs.existsSync(path.join(root,f))&&fs.statSync(path.join(root,f)).isFile());
  for (const check of Object.values(verification)) if(check.sourceCut) {
    check.sourceCut.changedBeforeReport=verificationCutChanged(check.sourceCut.fingerprints, sourceCut(Object.keys(check.testSourceFingerprints)));
    if(check.status==='PASS' && check.sourceCut.changedBeforeReport.length) check.status='PASS_ON_CHANGED_SOURCE_CUT_REVALIDATION_REQUIRED';
  }
  const criterionReviewPath='docs/implementation/verification/pdp-38/direct-definition-criteria-review.json';
  const definitionCriterionReviews={};
  if(fs.existsSync(path.join(root,criterionReviewPath))) {
    const artifact=JSON.parse(fs.readFileSync(path.join(root,criterionReviewPath),'utf8'));
    if(artifact.schemaVersion!=='media.pdp38-direct-definition-criteria-review.v1') throw new Error('Unsupported direct criterion review');
    for(const record of artifact.records) {
      if(!taskIds.includes(record.taskId) || definitionCriterionReviews[record.taskId]) throw new Error('Invalid or duplicate criterion review identity');
      const current=Object.entries(record.sourceFingerprints??{}).length>0 && Object.entries(record.sourceFingerprints).every(([file,hash])=>fs.existsSync(path.join(root,file))&&digest(file)===hash);
      definitionCriterionReviews[record.taskId]={...record,artifactRef:criterionReviewPath,sourceCutCurrent:current};
    }
  }
  const report=buildReadiness({audit,residual:buildMediaProductDefinitionResidualReport(root),verification,
    definitionCriterionReviews,
    mainSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fingerprints:Object.fromEntries(evidenceFiles.sort().map(f=>[f,digest(f)])),definitionCensus:buildCurrentDefinitionCensus(root),
    sourceWorkingTree:{
      boundary:'Fingerprints describe the working sources. HEAD identifies the committed base; uncommitted changes are not claimed to exist on published main.',
      porcelain:execFileSync('git',['status','--porcelain','--','.product-experience','scripts','tests','config/closure','libs/media-experience-simulation'],{cwd:root,encoding:'utf8'}).trim(),
    }});
  const json=JSON.stringify(report,null,2)+'\n';
  if(args.includes('--write')) {
    fs.writeFileSync(path.join(root,'docs/implementation/media-pdp-38-readiness.json'),json);
    const rows=report.tasks.map(t=>`| ${t.id} | ${t.originalLedgerStatus} | ${t.taskSpecificSourceDone} | ${t.dependencyReady} | ${t.independentOrPublisherAccepted} | ${t.nativePhaseProofCurrent} |`);
    fs.writeFileSync(path.join(root,'docs/implementation/media-pdp-38-readiness.md'),`# PDP-0 through PDP-3 readiness\n\nSource HEAD: \`${report.mainSha}\`. Exactly 38 tasks. Source criteria, dependencies, independent acceptance and Lifecycle currentness are separate. Historical ledger criteria/status are preserved. See JSON for current source fingerprints, test outputs and historical residual provenance.\n\n| Task | Original status | Direct source criterion | Dependencies | Independent/publisher | Native phase proof |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nCurrent source counters:\n\n\`\`\`json\n${JSON.stringify(report.currentCounters,null,2)}\n\`\`\`\n`);
    console.log(JSON.stringify({tasks:report.taskCount,counters:report.currentCounters,verification},null,2));
  } else process.stdout.write(json);
  if(report.diagnostics.length || Object.values(verification).some(v=>v.status==='FAIL')) process.exitCode=1;
}
