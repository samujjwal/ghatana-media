#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMediaProductDefinitionResidualReport } from './lib/media-product-definition-residuals.mjs';

export const taskIds = [8, 11, 9, 10].flatMap((n, phase) => Array.from({length:n}, (_,i) => `P${phase}-${String(i+1).padStart(2,'0')}`));
export function validateTaskPopulation(tasks) {
  const ids = tasks.map(t => t.id);
  if (ids.length !== 38 || new Set(ids).size !== 38 || taskIds.some(id => !ids.includes(id))) throw new Error('Readiness must contain exactly the 38 mandated PDP task identities');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const suites = {
  'P0-04': ['tests/pdp-0-final.test.mjs', 'tests/media-product-definition-resolved-intents.test.mjs'],
  'P1-06': ['tests/media-typed-contract-bindings.test.mjs'],
  'P2-01': ['tests/pdp-2-tools-experience-language-contract.test.mjs', 'tests/pdp-2-experience-language-projection.test.mjs'],
};
export function buildReadiness({audit, residual, verification = {}, mainSha, fingerprints}) {
  const tasks = audit.tasks.filter(t => taskIds.includes(t.id)).map(t => {
    const knownMet = t.id === 'P0-04' || t.ledgerStatus === 'complete';
    const check = verification[t.id];
    const verified = knownMet && check?.status === 'PASS';
    return {
      id:t.id, title:t.title, originalLedgerStatus:t.ledgerStatus,
      originalFullTaskDone: t.ledgerStatus === 'complete',
      taskSpecificSourceDone: verified ? 'VERIFIED_IN_CURRENT_SOURCE' : knownMet ? 'PRIOR_SOURCE_AUDIT_MET_REVALIDATION_REQUIRED' : 'NOT_ESTABLISHED',
      definitionCriterionSatisfied:verified,
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
    };
  });
  validateTaskPopulation(tasks);
  return {
    schemaVersion:'media.pdp-38-readiness.v1', mainSha,
    authority:'Diagnostic scope overlay. Original ledger and independent/Lifecycle authorities are unchanged. Previous audit residuals are historical, not a live semantic census.',
    taskCount:38, sourceFingerprints:fingerprints, tasks,
    phases:[0,1,2,3].map(p => ({id:`PDP-${p}`,definition:'INCOMPLETE',sourceValidation:'SEE_VERIFICATION_RECORDS',semanticAcceptance:'NOT_ESTABLISHED',independentReview:'NOT_EVALUATED',proofAdmission:'NOT_EVALUATED',lifecycleCurrent:'NOT_EVALUATED'})),
    currentCounters:{
      capabilityLeaves:residual.capabilityCoverage.leafCount,
      unresolvedCapabilityTargets:residual.capabilityCoverage.unresolvedCount,
      migrationSemanticUnresolved:residual.migrationSemantics.unresolvedCount,
      migrationMixed:residual.migrationSemantics.mixedRequiresDecompositionCount,
      interfaceIdentities:residual.operationParity.totalObservedIdentities,
      interfaceUnresolved:residual.operationParity.unresolvedIdentityCount,
      acceptedInterfaceBindings:residual.operationParity.acceptedBindingCount,
      designGates:residual.designConformance.gateCount,
      designOpenGates:residual.designConformance.openGateCount,
      screens:residual.productExperience.screenViewCount, journeys:residual.productExperience.journeyCount,
      steps:residual.productExperience.stepCount, stepsWithoutActions:residual.productExperience.stepsWithoutActionBindings,
      projectionBlockers:Object.fromEntries(residual.projections.map(p=>[p.phase,p.unresolvedFieldCount])),
      obligations:residual.lifecycle.obligationCount,
      obligationsWithoutCases:residual.lifecycle.obligationsWithoutCaseIds,
      localReceiptRecords:residual.lifecycle.localReceiptRecordCount,
      authoritativeReceiptCount:residual.lifecycle.receiptEvaluation.authoritativeReceiptCount,
      currentness:residual.lifecycle.currentnessEvaluation,
    }, diagnostics:residual.diagnostics,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if(args.some(a=>!['--verify','--write'].includes(a))) throw new Error('Usage: report-media-pdp-readiness.mjs [--verify] [--write]');
  const verification = {};
  if(args.includes('--verify')) for(const [id, files] of Object.entries(suites)) {
    const missing=files.filter(f=>!fs.existsSync(path.join(root,f)));
    if(missing.length) {verification[id]={status:'NOT_RUN',reason:`Missing test sources: ${missing.join(', ')}`};continue;}
    const result=spawnSync(process.execPath,['--test',...files],{cwd:root,encoding:'utf8'});
    verification[id]={status:result.status===0?'PASS':'FAIL',command:`node --test ${files.join(' ')}`,exitCode:result.status,
      outputSha256:crypto.createHash('sha256').update((result.stdout??'')+(result.stderr??'')).digest('hex'),testSourceFingerprints:Object.fromEntries(files.map(f=>[f,digest(f)]))};
    fs.mkdirSync(path.join(root,'docs/implementation/verification/pdp-38'),{recursive:true});
    fs.writeFileSync(path.join(root,`docs/implementation/verification/pdp-38/${id}.log`),(result.stdout??'')+(result.stderr??''));
  }
  const auditPath='docs/implementation/media-task-completion-blocker-report-2026-10-08.json';
  const audit=JSON.parse(fs.readFileSync(path.join(root,auditPath),'utf8'));
  const evidenceFiles=[auditPath,...new Set(audit.tasks.filter(t=>taskIds.includes(t.id)).flatMap(t=>t.evidenceSources??[]).map(f=>f.split('#')[0]))].filter(f=>fs.existsSync(path.join(root,f))&&fs.statSync(path.join(root,f)).isFile());
  const report=buildReadiness({audit,residual:buildMediaProductDefinitionResidualReport(root),verification,
    mainSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fingerprints:Object.fromEntries(evidenceFiles.sort().map(f=>[f,digest(f)]))});
  const json=JSON.stringify(report,null,2)+'\n';
  if(args.includes('--write')) {
    fs.writeFileSync(path.join(root,'docs/implementation/media-pdp-38-readiness.json'),json);
    const rows=report.tasks.map(t=>`| ${t.id} | ${t.originalLedgerStatus} | ${t.taskSpecificSourceDone} | ${t.dependencyReady} | ${t.independentOrPublisherAccepted} | ${t.nativePhaseProofCurrent} |`);
    fs.writeFileSync(path.join(root,'docs/implementation/media-pdp-38-readiness.md'),`# PDP-0 through PDP-3 readiness\n\nSource HEAD: \`${report.mainSha}\`. Exactly 38 tasks. Source criteria, dependencies, independent acceptance and Lifecycle currentness are separate. Historical ledger criteria/status are preserved. See JSON for current source fingerprints, test outputs and historical residual provenance.\n\n| Task | Original status | Direct source criterion | Dependencies | Independent/publisher | Native phase proof |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nCurrent source counters:\n\n\`\`\`json\n${JSON.stringify(report.currentCounters,null,2)}\n\`\`\`\n`);
    console.log(JSON.stringify({tasks:report.taskCount,counters:report.currentCounters,verification},null,2));
  } else process.stdout.write(json);
  if(report.diagnostics.length || Object.values(verification).some(v=>v.status==='FAIL')) process.exitCode=1;
}
