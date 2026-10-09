#!/usr/bin/env python3
import yaml,glob,os,re
from pathlib import Path
root=Path('.')
source=Path('.product-experience/pdp-3-product-experience/view-state-binding-dispositions.yaml')
d=yaml.safe_load(source.read_text())
action_registry=yaml.safe_load(Path('.product-experience/pdp-3-product-experience/action-registry.yaml').read_text())
action_records={x['id']:x for x in action_registry.get('actions',[])}
# Observation families consume only source-declared action IDs appropriate to that fact type.
family_action_ids={
 'OWNER_JOB_STATE': {'media.action.view-job-status','media.action.check-job-outcome'},
 'OWNER_ARTIFACT_STATE': {'media.action.inspect-artifact','media.action.inspect-output-preview-and-version'},
 'OWNER_RIGHTS_STATE': {'media.action.inspect-governing-evidence','media.action.inspect-consent-and-permitted-use','media.action.inspect-voice-authorization'},
 'OWNER_QUALITY_STATE': {'media.action.inspect-quality-evidence','media.action.compare-candidate-on-metric'},
 'OWNER_PROFILE_STATE': {'media.action.search-named-profiles','media.action.validate-processing-profile','media.action.inspect-operation-readiness','media.action.inspect-operation-contract'},
 'OWNER_PROVENANCE_STATE': {'media.action.inspect-provenance'},
 'LOCAL_QUERY': {'media.action.open-project','media.action.inspect-artifact','media.action.search-product-guidance','media.action.search-by-user-outcome','media.action.search-named-profiles'},
 'LOCAL_QUERY_EMPTY': {'media.action.open-project','media.action.inspect-artifact','media.action.search-product-guidance','media.action.search-by-user-outcome','media.action.search-named-profiles'},
}
# Owner-authored typed observation families. Inputs represent observed/local facts only;
# they are not an authority evaluation or a claim that a service/runtime emitted them.
families={
 'LOCAL_INFLIGHT':('local.operation.disposition','PENDING','An exact operation request is still locally observed as pending; no remote effect or completion is inferred.'),
 'LOCAL_CONNECTIVITY':('local.connectivity','OFFLINE','The current client reports no connectivity; remote work may continue and its outcome remains unknown.'),
 'LOCAL_STALENESS':('local.evidence.currentness','STALE','The displayed evidence is marked stale under the selected local freshness policy; this does not imply that the owner state changed.'),
 'LOCAL_IDENTITY':('host.identityContext.disposition','REAUTHENTICATION_REQUIRED','The host identity adapter reports that this local view lacks a current authenticated context; this is not an authentication decision by Media.'),
 'LOCAL_ACCESS':('host.authorityObservation.disposition','DENIED','A scoped host/owner authority observation explicitly denies this exact requested operation; missing/unknown evidence is not denial.'),
 'LOCAL_UNKNOWN':('local.operation.finality','UNKNOWN_OUTCOME','The exact request has ambiguous finality; preserve request identity and reconcile before any retry.'),
 'LOCAL_DRAFT':('local.editor.draftDisposition','DIRTY','The local draft differs from its exact base revision; it is not persisted until an owner receipt confirms a new revision.'),
 'LOCAL_DRAFT_CLEAN':('local.editor.draftDisposition','CLEAN','The current local draft equals its exact base revision; this does not assert that an earlier save succeeded.'),
 'LOCAL_SELECTION':('local.editor.selectionDisposition','SELECTED','The exact source/version tuple is selected in the local view; selection does not imply authorization or availability.'),
 'LOCAL_VALIDATION':('local.validation.disposition','VALID','The exact current draft passed the named local validator and bounds; this does not grant authority or qualify an implementation.'),
 'LOCAL_VALIDATION_INVALID':('local.validation.disposition','INVALID','The exact current draft failed the named validator; display its concrete error reference without inferring a domain transition.'),
 'OWNER_JOB_STATE':('ownerObservation.job.state','OBSERVED_CANONICAL_STATE','A current owner-issued status snapshot for one exact job/attempt reports the stated canonical job state. Current job query schemas do not yet expose status, so this predicate remains UNKNOWN until the source field is added.'),
 'OWNER_ARTIFACT_STATE':('ownerObservation.artifact.lifecycleState','OBSERVED_CANONICAL_STATE','A current owner-issued artifact/version observation reports the stated canonical lifecycle state. A reference alone is insufficient.'),
 'OWNER_RIGHTS_STATE':('ownerObservation.rightsConsent.disposition','OBSERVED_CANONICAL_STATE','A current scoped rights/consent observation reports the stated disposition; a user attestation alone is not verification.'),
 'OWNER_QUALITY_STATE':('ownerObservation.quality.disposition','OBSERVED_CANONICAL_STATE','A typed, applicable quality observation reports this disposition with method, scope, uncertainty and evidence reference; no metric is inferred from a label.'),
 'OWNER_PROFILE_STATE':('ownerObservation.profile.disposition','OBSERVED_CANONICAL_STATE','A current versioned profile validation reports this disposition for the exact requested target and profile.'),
 'OWNER_PROVENANCE_STATE':('ownerObservation.provenance.disposition','OBSERVED_CANONICAL_STATE','An exact-version lineage query reports this provenance disposition; missing lineage stays incomplete rather than inferred.'),
 'LOCAL_QUERY':('local.query.disposition','RESULTS_PRESENT','The exact scoped query returned one or more rows at its observedAt; this is not a global inventory or absence claim.'),
 'LOCAL_QUERY_EMPTY':('local.query.disposition','NO_ROWS_IN_SCOPE','The exact scoped query returned zero rows at observedAt; this is not global absence.'),
 'LOCAL_PRESENTATION':('local.view.presentationState','ACTIVE','A screen-local presentation condition is active for its exact view context; it does not assert persisted domain state.'),
}

def slug(s): return re.sub(r'[^a-z0-9]+','-',s.lower()).strip('-')
def choose(view,label,screen):
 l=label.lower()
 if l in ('loading','checking','saving','submission-pending','validation-pending','verification-pending','tracking-pending','measurement-pending','alignment-pending','source-verifying','receiving','processing','running') and 'running' not in l: return 'LOCAL_INFLIGHT', 'pending local operation observation'
 if l=='offline': return 'LOCAL_CONNECTIVITY','local connectivity only'
 if 'stale' in l: return 'LOCAL_STALENESS','freshness decision for exact evidence snapshot'
 if l in ('identity-required','identity-expired','reauthentication-required'): return 'LOCAL_IDENTITY','host identity adapter disposition'
 if l in ('access-denied','workspace-denied','permission-denied','context-denied','denied','policy-blocked','rights-blocked'): return 'LOCAL_ACCESS','scoped authority or policy observation'
 if l in ('outcome-unknown','create-outcome-unknown','job-outcome-unknown','reconciling','evidence-unavailable'): return 'LOCAL_UNKNOWN','same-request finality/reconciliation'
 if l in ('draft','dirty','editing','adjustment-dirty','curve-editing','translation-draft'): return 'LOCAL_DRAFT','local unsaved draft against exact base'
 if l in ('saved','saved-version','decision-recorded','attestation-recorded'): return 'LOCAL_DRAFT_CLEAN','durable owner receipt required to call persisted'
 if l in ('selection-active','keyframe-selected','source-selected','intent-selected','region-required','ready','profiles-ready','source-available','candidate-ready','ready-for-review','ready-to-submit','plan-ready','plan-ready-for-review','valid','context-selectable','authorized-to-review','permitted-with-scope'): return 'LOCAL_VALIDATION','typed current input/selection/guard snapshot'
 if l in ('missing-input','source-missing','source-required','evidence-required','evidence-missing','missing-input','reference-missing','asset-missing','destination-required','region-required','alignment-required','needs-alignment','language-unsupported','consent-required','unsupported-control','unsupported-operation','invalid','invalid-input','bounds-invalid','profile-incompatible','incompatible','no-profile','measurement-unavailable','candidate-unavailable','unavailable','operation-unavailable','unconfigured'): return 'LOCAL_VALIDATION_INVALID','specific missing/invalid input or unavailable-evidence reason'
 if l in ('queued','running','partially-succeeded','partial','partial-result','job-running','job-partial','completed','failed','cancelled','cancellation-pending','retry-pending','outcome-unknown','reconciling','job-completed','job-failed'): return 'OWNER_JOB_STATE','exact job status snapshot; source schema currently lacks the typed state field'
 if l in ('available','quarantined','rejected','verifying','metadata-incomplete','stale-version','permission-revoked','outputs-available','output-quarantined','no-output','preview-unavailable','source-quarantined','integrity-incomplete'): return 'OWNER_ARTIFACT_STATE','exact artifact/version lifecycle observation; references alone do not qualify'
 if l in ('permitted-with-scope','denied','unknown','expired','revoked','rights-review-required','approval-expired','approval-required','review-required','voice-authorization-required','consent-revoked','rights-unknown','evidence-required'): return 'OWNER_RIGHTS_STATE','scoped rights/consent evidence and exact current version'
 if l in ('not-assessed','measured','partial-evidence','measurement-pending','defect-observed','conflicting-evidence','recommendation-only','repair-plan-ready','quality-evidence-unavailable','language-uncertain','alignment-required','timing-incomplete','sync-review-required'): return 'OWNER_QUALITY_STATE','applicability-aware evidence for exact source/version'
 if l in ('qualified','profile-unqualified','declared','proposal-only','implemented-unqualified','owner-review-required','evidence-stale','profile-incompatible','binding-unqualified','unqualified-domain','unqualified'): return 'OWNER_PROFILE_STATE','exact versioned qualification/profile evidence'
 if l in ('complete-lineage','partial-lineage','generated-origin','inferred-origin','source-missing','execution-record-unavailable','access-limited'): return 'OWNER_PROVENANCE_STATE','exact versioned provenance query'
 if l in ('projects-available','artifacts-available','results-ready','populated','no-matching-projects','workspace-empty','empty','empty-project','no-results','no-guidance','empty-scene','no-profile','no-output'): return ('LOCAL_QUERY_EMPTY' if l in ('no-matching-projects','workspace-empty','empty','empty-project','no-results','no-guidance','empty-scene','no-profile','no-output') else 'LOCAL_QUERY'),'exact scoped query page, not a global inventory'
 return 'LOCAL_PRESENTATION','view-local display condition; no domain lifecycle or authorization is asserted'

allrows=[]
for v in d['views']:
 fname=Path(v['screenContractRef'].split('#')[0]); s=yaml.safe_load(fname.read_text())
 for i,item in enumerate(v['stateLabelDispositions']):
  label=item['label']; fam,why=choose(v['viewRef'],label,s); factpath,expected,meaning=families[fam]
  src=item.get('sourceRef') or f"{v['screenContractRef']}#/states/{i}"
  declared_actions=[a.get('actionId') for a in s.get('actionConsequences',[]) if isinstance(a,dict) and a.get('actionId')]
  selected=set(family_action_ids.get(fam, set()))
  actions=[a for a in declared_actions if a in selected]
  if not actions and fam in ('LOCAL_INFLIGHT','LOCAL_UNKNOWN','LOCAL_VALIDATION','LOCAL_VALIDATION_INVALID','LOCAL_DRAFT','LOCAL_DRAFT_CLEAN','LOCAL_SELECTION'):
   # Local interaction state is tied to exact owner-declared editor/submit actions on this screen.
   actions=[a for a in declared_actions if a in action_records and action_records[a].get('actionDefinitionSemantics',{}).get('typedDefinition',{}).get('semanticRole') in ('LOCAL_SELECTION','LOCAL_SESSION_DRAFT','DOMAIN_OPERATION')]
  ops=[]
  for action_ref in actions:
   rec=action_records.get(action_ref,{})
   sem=rec.get('actionDefinitionSemantics',{}).get('typedDefinition',{})
   binding=sem.get('canonicalOperationBindings',{}).get('operationRef')
   exact=sem.get('exactOperationRefs',[])
   for ref in ([binding] if binding else exact):
    if ref and ref not in ops: ops.append(ref)
  for ref in (item.get('evidenceOperationRefs') or s.get('operationRefs') or []):
   if ref not in ops: ops.append(ref)
  # All source operation/action arrays are exact references only; no inference of admission.
  # Normalize each UI phrase to a typed observation value; for canonical lifecycle values the state machine is exact.
  normalized=label.upper().replace('-','_')
  values={
   'OWNER_JOB_STATE': {'partially-succeeded':'PARTIALLY_SUCCEEDED','cancellation-pending':'CANCEL_REQUESTED','retry-pending':'RETRY_PENDING','job-running':'RUNNING','job-partial':'PARTIALLY_SUCCEEDED','job-completed':'COMPLETED','job-failed':'FAILED'},
   'OWNER_ARTIFACT_STATE': {'permission-revoked':'ACCESS_REVOKED','metadata-incomplete':'METADATA_INCOMPLETE','outputs-available':'AVAILABLE','output-quarantined':'QUARANTINED','source-quarantined':'QUARANTINED'},
   'OWNER_RIGHTS_STATE': {'permitted-with-scope':'PERMITTED_WITH_SCOPE','rights-review-required':'REVIEW_REQUIRED','approval-expired':'EXPIRED','approval-required':'APPROVAL_REQUIRED','voice-authorization-required':'AUTHORIZATION_REQUIRED','consent-revoked':'REVOKED','rights-unknown':'UNKNOWN','evidence-required':'EVIDENCE_REQUIRED','evidence-missing':'EVIDENCE_MISSING'},
   'OWNER_QUALITY_STATE': {'not-assessed':'NOT_ASSESSED','measured':'EVIDENCE_PRESENT','partial-evidence':'PARTIAL_EVIDENCE','measurement-pending':'PENDING','defect-observed':'DEFECT_OBSERVED','conflicting-evidence':'CONFLICTING_EVIDENCE','recommendation-only':'RECOMMENDATION_ONLY','repair-plan-ready':'REPAIR_PLAN_READY','quality-evidence-unavailable':'UNAVAILABLE','language-uncertain':'UNCERTAIN','alignment-required':'ALIGNMENT_REQUIRED','timing-incomplete':'INCOMPLETE','sync-review-required':'REVIEW_REQUIRED'},
   'OWNER_PROFILE_STATE': {'qualified':'QUALIFIED','profile-unqualified':'UNQUALIFIED','declared':'DECLARED','proposal-only':'PROPOSAL_ONLY','implemented-unqualified':'IMPLEMENTED_UNQUALIFIED','owner-review-required':'OWNER_REVIEW_REQUIRED','evidence-stale':'STALE','profile-incompatible':'INCOMPATIBLE','binding-unqualified':'UNQUALIFIED','unqualified-domain':'UNQUALIFIED','unqualified':'UNQUALIFIED'},
   'OWNER_PROVENANCE_STATE': {'complete-lineage':'COMPLETE','partial-lineage':'PARTIAL','generated-origin':'GENERATED','inferred-origin':'INFERRED','source-missing':'SOURCE_MISSING','execution-record-unavailable':'UNAVAILABLE','access-limited':'ACCESS_LIMITED'},
  }
  expected=values.get(fam,{}).get(label,normalized)
  negative={
   'LOCAL_INFLIGHT':'SETTLED','LOCAL_CONNECTIVITY':'ONLINE','LOCAL_STALENESS':'CURRENT','LOCAL_IDENTITY':'CONTEXT_READY','LOCAL_ACCESS':'ALLOWED','LOCAL_UNKNOWN':'FINAL_KNOWN','LOCAL_DRAFT':'CLEAN','LOCAL_DRAFT_CLEAN':'DIRTY','LOCAL_SELECTION':'NONE','LOCAL_VALIDATION':'INVALID','LOCAL_VALIDATION_INVALID':'VALID','OWNER_JOB_STATE':'UNKNOWN','OWNER_ARTIFACT_STATE':'UNKNOWN','OWNER_RIGHTS_STATE':'UNKNOWN','OWNER_QUALITY_STATE':'UNKNOWN','OWNER_PROFILE_STATE':'UNKNOWN','OWNER_PROVENANCE_STATE':'UNKNOWN','LOCAL_QUERY':'NO_ROWS_IN_SCOPE','LOCAL_QUERY_EMPTY':'RESULTS_PRESENT','LOCAL_PRESENTATION':'INACTIVE'
  }[fam]
  if negative == expected or negative == 'UNKNOWN':
   negative = next((value for value in sorted(values.get(fam, set([expected, 'UNKNOWN']))) if value not in (expected, 'UNKNOWN')), 'NOT_APPLICABLE')
  record={
   'predicateId':f"media.view-observation.{slug(v['viewRef'].removeprefix('media.view.'))}.{slug(label)}.v1",
   'viewRef':v['viewRef'],'screenSourceRef':src,'label':label,'factKind':fam,
   'factPath':factpath,'expectedValue':expected,'negativeValue':negative,'factSchemaRef':f'.product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml#factSchemas.{fam}','meaning':meaning,
   'factScope':{'viewRef':v['viewRef'],'operationRefs':ops,'actionRefs':actions,'requiredIdentityFields':{
    'LOCAL_INFLIGHT':['requestId'],'LOCAL_UNKNOWN':['requestId','requestFingerprint'],'LOCAL_DRAFT':['sessionId','baseVersionRef'],'LOCAL_DRAFT_CLEAN':['sessionId','baseVersionRef','ownerReceiptRef'],'LOCAL_SELECTION':['targetRef','versionRef'],'LOCAL_VALIDATION':['targetRef','versionRef','validatorRef'],'LOCAL_VALIDATION_INVALID':['targetRef','versionRef','validatorRef'],
    'OWNER_JOB_STATE':['tenantId','jobId','observedAt'],'OWNER_ARTIFACT_STATE':['tenantId','artifactId','versionId','observedAt'],'OWNER_RIGHTS_STATE':['tenantId','subjectRef','purposeRef','versionRef','observedAt'],'OWNER_QUALITY_STATE':['artifactId','versionId','metricRef','evidenceRef','observedAt'],'OWNER_PROFILE_STATE':['operationRef','profileRef','targetRef','profileVersion','observedAt'],'OWNER_PROVENANCE_STATE':['artifactId','versionId','observedAt'],'LOCAL_QUERY':['tenantId','principalId','workspaceId','queryId','observedAt'],'LOCAL_QUERY_EMPTY':['tenantId','principalId','workspaceId','queryId','observedAt'],
    'LOCAL_STALENESS':['snapshotRef','freshnessPolicyRef','observedAt'],'LOCAL_IDENTITY':['hostContextRef','nonce','returnRouteRef'],'LOCAL_ACCESS':['tenantId','principalId','targetRef','requestScopeRef','observedAt'],'LOCAL_CONNECTIVITY':['clientInstanceRef','observedAt'],'LOCAL_PRESENTATION':['viewSessionId'],'LOCAL_DRAFT':['sessionId','baseVersionRef']
   }.get(fam,['viewSessionId'])},
   'truthRules':{'TRUE':'exact fact value and exact view/operation scope match','FALSE':'same typed fact/scope supplied with a nonmatching value','UNKNOWN':'fact, scope, owner observation, freshness, or exact source field is absent/invalid'},
   'positiveFixture':{'value':expected,'scope':v['viewRef'],'operationRef':ops[0] if ops else None,'currentness':'CURRENT','identity':{k:f'fixture:{slug(v["viewRef"])}:{k}' for k in ({'LOCAL_INFLIGHT':['requestId'],'LOCAL_UNKNOWN':['requestId','requestFingerprint'],'LOCAL_DRAFT':['sessionId','baseVersionRef'],'LOCAL_DRAFT_CLEAN':['sessionId','baseVersionRef','ownerReceiptRef'],'LOCAL_SELECTION':['targetRef','versionRef'],'LOCAL_VALIDATION':['targetRef','versionRef','validatorRef'],'LOCAL_VALIDATION_INVALID':['targetRef','versionRef','validatorRef'],'OWNER_JOB_STATE':['tenantId','jobId'],'OWNER_ARTIFACT_STATE':['tenantId','artifactId','versionId'],'OWNER_RIGHTS_STATE':['tenantId','subjectRef','purposeRef','versionRef'],'OWNER_QUALITY_STATE':['artifactId','versionId','metricRef','evidenceRef'],'OWNER_PROFILE_STATE':['operationRef','profileRef','targetRef','profileVersion'],'OWNER_PROVENANCE_STATE':['artifactId','versionId'],'LOCAL_QUERY':['tenantId','principalId','workspaceId','queryId'],'LOCAL_QUERY_EMPTY':['tenantId','principalId','workspaceId','queryId'],'LOCAL_STALENESS':['snapshotRef','freshnessPolicyRef'],'LOCAL_IDENTITY':['hostContextRef','nonce','returnRouteRef'],'LOCAL_ACCESS':['tenantId','principalId','targetRef','operationRef'],'LOCAL_CONNECTIVITY':['clientInstanceRef'],'LOCAL_PRESENTATION':['viewSessionId']}.get(fam,['viewSessionId']))}},
   'negativeFixture':{'value':negative,'scope':v['viewRef'],'operationRef':ops[0] if ops else None,'currentness':'CURRENT','identity':{'fixtureRef':'negative-scope'}},
   'unknownFixture':{'value':None,'scope':v['viewRef'],'operationRef':ops[0] if ops else None,'currentness':'UNKNOWN'},
   'sourceStatus':'MEDIA_OWNER_DEFINITION; RUNTIME_NOT_ADMITTED'
  }
  if fam.startswith('OWNER_'):
   record['canonicalObservationLimitation']='A typed proposal fact is necessary; do not render the state from UI label, operation acceptance, local draft, or an opaque reference alone.'
   if fam=='OWNER_JOB_STATE': record['sourceFieldStatus']='PDP1_JOB_STATUS_QUERY_SCHEMA_LACKS_STATE_FIELD; TRUTH_DOMAIN_ACTION_REQUIRED'
  if not ops and 'operationRef' in record['factScope']['requiredIdentityFields']:
   record['factScope']['requiredIdentityFields'].remove('operationRef')
  for fixture_name in ('positiveFixture','negativeFixture','unknownFixture'):
   fx=record[fixture_name]
   fx['identity']={k:f'fixture:{slug(v["viewRef"])}:{k}' for k in record['factScope']['requiredIdentityFields']}
   if fx.get('operationRef'):
    fx['identity']['operationRef']=fx['operationRef']
  allrows.append(record)
out={
 'schemaVersion':'media.pdp-3-view-observation-predicates.v1',
 'status':'MEDIA_OWNER_DEFINITION; INDEPENDENT_PDP3_REVIEW_OPEN',
 'decisionRef':'.product-experience/decision-log.md#PXD-119',
 'sourceAuthority':'.product-experience/pdp-3-product-experience/view-state-binding-dispositions.yaml',
 'factBoundary':'Inputs are definition-oracle observations, not authority evaluation, transport evidence, provider execution, runtime admission, or phase acceptance.',
 'viewCount':len(d['views']),'predicateCount':len(allrows),'predicates':allrows
}
# Remove label-as-proof fixtures. Query predicates below derive from raw scoped rows.
job_raw_status={'queued':'ACCEPTED','running':'RUNNING','partially-succeeded':'PARTIALLY_SUCCEEDED','partial':'PARTIALLY_SUCCEEDED','job-partial':'PARTIALLY_SUCCEEDED','job-running':'RUNNING','completed':'COMPLETED','job-completed':'COMPLETED','failed':'FAILED','job-failed':'FAILED','cancelled':'CANCELLED','cancellation-pending':'CANCELLED','retry-pending':'ACCEPTED','reconciling':'OUTCOME_UNKNOWN'}
job_reason={'ACCEPTED':'Does not establish durable queueing, so it cannot map to canonical QUEUED.','RUNNING':'Lacks fenced current-attempt evidence required for canonical RUNNING.','PARTIALLY_SUCCEEDED':'The stored response does not prove canonical partial success or registered output dispositions.','COMPLETED':'Stored status does not establish verified registered outputs required for canonical COMPLETED.','FAILED':'Stored response does not establish no eligible continuation or persisted failure truth required for canonical FAILED.','CANCELLED':'Stored response does not establish cancellation finality for every effect that can still mutate the job.'}
for row in allrows:
 for field in ('expectedValue','negativeValue','positiveFixture','negativeFixture','unknownFixture'):
  row.pop(field,None)
 row['truthRules']={'TRUE':'typed raw facts satisfy scope, closed schema, freshness, and semantic conditions','FALSE':'complete current in-scope facts contradict the condition','UNKNOWN':'missing, stale, malformed, unsupported, mismatched, or contradictory facts'}
 if row['factKind']=='LOCAL_QUERY':
  row['queryPredicate']={'kind':'NONEMPTY','meaning':'Fresh successful scoped query with at least one result row.'}
 elif row['factKind']=='LOCAL_QUERY_EMPTY':
  row['queryPredicate']={'kind':'EMPTY_COMPLETE_QUERY' if row['label']=='workspace-empty' else 'EMPTY_SCOPED_PAGE','meaning':'Zero rows apply only to this exact query; complete absence requires a complete query.'}
 elif row['factKind']=='LOCAL_PRESENTATION' and row['label']=='populated-project':
  row['queryPredicate']={'kind':'NONEMPTY','meaning':'Fresh successful project query returned one or more project rows in the trusted workspace.'}
 if row['factKind']=='OWNER_JOB_STATE':
  label=row['label']; status=job_raw_status.get(label,'OUTCOME_UNKNOWN')
  exact=(label in ('outcome-unknown','job-outcome-unknown'))
  if exact: status='OUTCOME_UNKNOWN'
  row['jobStatusObservation']={'ownerReadModelRef':'.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.inspect-job/ownerWireSchema','queryOperationRef':'media.operation-slice.inspect-job','runtimeStatus':status,'mappingDisposition':'EXACT_CANONICAL_STATE' if exact else 'NOT_MAPPED_RUNTIME_ONLY','canonicalStateRef':'.product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN' if exact else None,'nonMappingReason':None if exact else job_reason.get(status,'Source status has no canonical state mapping.'),'displayBoundary':'A raw stored runtime status is not a canonical transition or finality proof.'}
  row['factScope']['operationRefs']=list(dict.fromkeys(['media.operation-slice.inspect-job']+row['factScope'].get('operationRefs',[])))
  row['meaning']='A fresh trusted stored-job observation reports this runtime status. Only OUTCOME_UNKNOWN maps to a canonical P1 job state; all other statuses retain NOT_MAPPED_RUNTIME_ONLY disposition and do not prove finality.'
  row['canonicalObservationLimitation']='Do not project runtime status into a canonical P1 state without an exact mapping and its resolved canonicalStateRef.'
 if row['label'] in ('outcome-unknown','job-outcome-unknown') and any(a in ('media.action.view-job-status','media.action.check-job-outcome') for a in row['factScope'].get('actionRefs',[])):
  row['jobStatusObservation']={'ownerReadModelRef':'.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.inspect-job/ownerWireSchema','queryOperationRef':'media.operation-slice.inspect-job','runtimeStatus':'OUTCOME_UNKNOWN','mappingDisposition':'EXACT_CANONICAL_STATE','canonicalStateRef':'.product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN','nonMappingReason':None,'displayBoundary':'This exact typed result identifies OUTCOME_UNKNOWN only; it does not establish completion, failure, replay safety, provider reconciliation, or a state transition.'}
  row['factScope']['operationRefs']=list(dict.fromkeys(['media.operation-slice.inspect-job']+row['factScope'].get('operationRefs',[])))
 if row['factKind']=='OWNER_ARTIFACT_STATE':
  row['sourceFieldStatus']='PDP1_INSPECT_QUERIES_DO_NOT_EXPOSE_TYPED_LIFECYCLE_STATE; TRUTH_DOMAIN_CONTRACT_PENDING'
  row['meaning']='This label requires a typed owner lifecycle observation for the exact immutable artifact version. Current inspect operations return references or metadata and do not prove lifecycle state.'
  row['canonicalObservationLimitation']='P1 lifecycle vocabulary is not read evidence; a metadata record or opaque reference is insufficient.'

Path('.product-experience/pdp-3-product-experience/view-observation-predicates.yaml').write_text(yaml.safe_dump(out,sort_keys=False,allow_unicode=True,width=110))
print('wrote',len(allrows))
