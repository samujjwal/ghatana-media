// Source-bound, read-only check of delegated task dispositions against generated
// Work Packages. This is NOT a Kernel Plan exit, native gtool proof or receipt.
export function validateMediaGtoolOwnerDispositions(decision, projection) {
  const errors=[];const fail=(code,taskId=null)=>errors.push({code,taskId});
  if(decision?.schemaVersion!=='media.gtool-build-owner-dispositions.v1' ||
     decision?.recordKind!=='DELEGATED_OWNER_DECISION_AND_EXECUTION_INPUT_NOT_GTOOL_RECEIPT')fail('DECISION_SCHEMA_INVALID');
  const work=Array.isArray(projection?.tasks)?projection.tasks:[];
  const ownerTasks=Array.isArray(decision?.tasks)?decision.tasks:[];
  if(projection?.schemaVersion==null || work.length!==57 || projection?.packages?.length!==50)fail('WORK_PACKAGE_BASELINE_INVALID');
  if(ownerTasks.length!==19 || decision?.planExit?.status!=='NOT_YET_PROVEN' ||
     decision?.status!=='APPROVED_OWNER_POLICY_TECHNICAL_TASKS_OPEN')fail('DISPOSITION_CLAIM_OR_DENOMINATOR_INVALID');
  const allTaskIds=new Set(work.map(t=>t.id)),idSet=new Set();
  for(const row of ownerTasks) {
    const id=row?.taskId;
    if(typeof id!=='string' || !/^M-BLD-[FVLX]\d{2}\.T\d{2}$/.test(id) || idSet.has(id))fail('OWNER_TASK_ID_MISSING_OR_DUPLICATE',id);
    idSet.add(id);
    if(!allTaskIds.has(id))fail('OWNER_TASK_NOT_IN_CANONICAL_WORK_PACKAGE',id);
    const projected=work.find(t=>t.id===id);
    if(!projected?.packageId || !id.startsWith(projected.packageId+'.'))fail('OWNER_TASK_PACKAGE_MISMATCH',id);
    if(row?.disposition!=='APPROVE_IMPLEMENTATION_PLANNING_AND_SOURCE_REPAIR' ||
      row?.status!=='OPEN_TECHNICAL_WORK' || row?.completionClaim!=='NOT_COMPLETE')fail('OWNER_TASK_FALSE_COMPLETION_OR_AUTHORITY',id);
    if(typeof row?.ownerRepository!=='string' || !row.ownerRepository.startsWith('samujjwal/') ||
       typeof row?.ownerRole!=='string' || !row.ownerRole ||
       !Array.isArray(row?.exactSourceAndTargetAreas) || row.exactSourceAndTargetAreas.length===0 ||
       !row?.implementationDirective || !row?.acceptanceCriterion || !row?.blockingDependencies ||
       !Array.isArray(row?.requiredStructuredIO?.input) || !Array.isArray(row?.requiredStructuredIO?.output))fail('OWNER_TASK_NOT_ACTIONABLE',id);
  }
  const declared=decision?.planExit?.blockingBuildTasks;
  if(!Array.isArray(declared) || declared.length!==19 ||
     declared.length!==idSet.size || declared.some(x=>!idSet.has(x)))fail('PLAN_TASK_EXIT_SET_MISMATCH');
  const sourceGaps=decision?.sourceGaps;
  if(sourceGaps?.buildContractBridge?.status!=='INCOMPLETE_SOURCE_RELATIONS' ||
     sourceGaps?.pdp0CaseMap?.executableLinks!==0 ||
     sourceGaps?.lifecycleAdmission?.nativeReceipts!=='NOT_PROVEN')fail('TECHNICAL_REMAINING_WORK_MISREPRESENTED');
  return {schemaVersion:'media.gtool-build-owner-disposition-audit.v1',
   structuralStatus:errors.length===0?'PASS':'FAIL',errors,
   workPackageTaskCount:work.length,approvedOwnerPolicyTaskCount:ownerTasks.length,
   remainingTechnicalTaskCount:ownerTasks.length,
   ownerApprovalStatus:errors.length===0?'OWNER_SCOPE_DECISIONS_APPROVED':'UNVERIFIED',
   kernelPlanReady:'NOT_PROVEN',pdpSourceDevelopment:'NOT_EVALUATED',
   gtoolClosure:'NOT_EVALUATED',writesPerformed:false};
}
