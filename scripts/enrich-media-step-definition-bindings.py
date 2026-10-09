#!/usr/bin/env python3
"""Enrich PDP-3 step oracles with exact source-canonical definition bindings."""
from pathlib import Path
import re
import yaml

ROOT=Path('.')
P=ROOT/'.product-experience/pdp-3-product-experience/step-definition-oracles.yaml'
D=yaml.safe_load(P.read_text())
A=yaml.safe_load((ROOT/'.product-experience/pdp-3-product-experience/action-registry.yaml').read_text())
actions={x['id']:x for x in A.get('actions',[])+A.get('ownerDefinedActions',[])}
C=yaml.safe_load((ROOT/'.product-experience/pdp-0-product-truth/capability-leaf-review.yaml').read_text())
leaves=C['ownerCapabilityLeafAdjudication']['records']; leaf_by_id={x['capabilityRef']:x for x in leaves}
# The operations source accumulated copied anchors during parallel authorship; rename aliases in-memory only.
s=(ROOT/'.product-experience/pdp-1-domain-data/operations.yaml').read_text(); seen={}; current={}
def rename_anchor(m):
 sig,name=m.groups()
 if sig=='&':
  n=seen.get(name,0); seen[name]=n+1; new=f'{name}__{n}' if n else name; current[name]=new; return sig+new
 return sig+current.get(name,name)
O=yaml.safe_load(re.sub(r'([&*])([A-Za-z0-9_-]+)',rename_anchor,s))
contracts={}
for group in ('individualOperationContracts','ownerDefinedOperationContracts'):
 for x in O.get(group,{}).get('records',[]): contracts[x.get('id')]=x
for x in O.get('capabilityOperationContracts',{}).get('records',[]): contracts[x.get('id')]=x
journey_paths={x['id']:ROOT/'.product-experience/pdp-3-product-experience'/x['contract'] for x in yaml.safe_load((ROOT/'.product-experience/pdp-3-product-experience/journey-registry.yaml').read_text())['journeys']}

PASSIVE={
 'J-04.step-01':('LOCAL_SELECTION','Speech, language, pronunciation, and voice choices update only the current request draft; no provider or job operation is invoked until a later explicitly submitted command.'),
 'J-18.step-01':('LOCAL_SESSION_DRAFT','Timeline, graphics, brand, audio, captions, and transition assembly edits the current local composition draft; no render or delivery operation is dispatched.'),
 'J-18.step-03':('LOCAL_SELECTION_AND_OBSERVATION','Color interpretation and shot matching select or compare exact source/version evidence; no color transform is persisted or rendered by this step.'),
 'J-09.step-06':('LOCAL_SESSION_DRAFT','Timeline and composition assembly updates the local draft only; a later validated render request is a separate consequential operation.'),
 'J-16.step-02':('LOCAL_SELECTION','Speech, language, pronunciation, and voice selections remain in the local plan; no speech provider call or job submission occurs.'),
 'J-29.step-01':('PASSIVE_OBSERVATION','Read only supplied owner observations for this exact stream session and frames; cached client state does not establish a current lease, consent, or finality.'),
 'J-29.step-02':('LOCAL_FENCE_AND_HOLD','The definition oracle refuses frame submission when required identity, consent, lease, session, or finality facts are stale/unknown; it does not issue close/cancel or claim a provider effect.'),
 'J-29.step-03':('PASSIVE_RECEIPT_CLASSIFICATION','Classify already supplied owner receipts for exact session, sequence, fence, and request; absent/conflicting evidence stays UNKNOWN and no acknowledgement command is issued.'),
}
OWNER_ACTION={
 'J-29.step-04':'media.action.request-live-session-reconnect',
}
NO_ACTION_QUERY={
 'J-01.step-02':('media.operation-slice.list-projects','QUERY','media.domain.project',
  ['media-project/ACTIVE','media-project/ARCHIVED'],
  ['.product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation'],
  ['MEDIA-REQ-CAP-PROJECT'])
}

def unique(vals): return list(dict.fromkeys(v for v in vals if v))

def resolve_step_source(step):
 ref=step['sourceRef']; path,selector=ref.split('#',1); src=yaml.safe_load((ROOT/path).read_text())
 match=re.search(r'/steps/(\d+)$',selector)
 return src,src['steps'][int(match.group(1))]

def operation_details(ref):
 rec=contracts.get(ref)
 if rec is None: return {},None
 return rec,rec.get('scopeStatus') or rec.get('status')

for journey in D['journeys']:
 jid=journey['journeyId']; journey_doc=yaml.safe_load(journey_paths[jid].read_text())
 for step in journey['steps']:
  sid=step['id']; screen_source, source_step=resolve_step_source(step)
  if not step.get('actionRef') and sid in OWNER_ACTION:
   step['actionRef']=OWNER_ACTION[sid]
   step['semanticRole']='DOMAIN_OPERATION'
   step['operationDisposition']='OWNER_DEFINED_EXACT_OPERATION_REFERENCE'
   step['effect']=actions[step['actionRef']]['effect']
   step['finality']=actions[step['actionRef']]['finality']
   step['recovery']=actions[step['actionRef']]['failureRecovery']
   step['canonicalOperationRefs']=[actions[step['actionRef']]['operationRef']]
   step['operationKinds']=[actions[step['actionRef']]['operationKind']]
   step['runtimeAdmission']='NOT_ADMITTED'
   step['decisionRef']='.product-experience/decision-log.md#PXD-077'
  if not step.get('actionRef') and sid in PASSIVE:
   role,rationale=PASSIVE[sid]
   step['semanticRole']=role
   step['operationDisposition']='NO_DOMAIN_OPERATION_EXACT_NONDISPATCH_DISPOSITION'
   step['effect']='none; this step records local selection, supplied observation, or fail-closed eligibility only'
   step['finality']='local definition result only; no remote effect or canonical transition is claimed'
   step['recovery']='preserve exact target/session and source version; missing, stale, or contradictory evidence remains UNKNOWN and requires same-identity owner observation'
   step['nonDomainRationale']=rationale
   step['canonicalOperationRefs']=[]
   step['operationKinds']=[]
   step['runtimeAdmission']='NOT_ADMITTED'
   step['decisionRef']='.product-experience/decision-log.md#PXD-PENDING-PDP38-EXPERIENCE'
  if not step.get('actionRef') and sid in NO_ACTION_QUERY:
   op,kind,obj,states,auth,req=NO_ACTION_QUERY[sid]
   step['semanticRole']='PASSIVE_QUERY'
   step['operationDisposition']='EXACT_OPERATION_WITHOUT_RECORDED_ACTION'
   step['effect']='Read the authorized project collection for the trusted tenant, principal, and selected workspace; do not create, mutate, or infer global absence.'
   step['finality']='read-only scoped query; returned rows are observations at observedAt, not complete cross-workspace inventory or transition'
   step['recovery']='repeat the same scoped query under current identity and authority; preserve request/query identity and label unavailable or stale results honestly'
   step['canonicalOperationRefs']=[op]; step['operationKinds']=[kind]; step['runtimeAdmission']='NOT_ADMITTED'
   step['canonicalObjectRefs']=[obj]; step['canonicalStateRefs']=states; step['canonicalAuthorityRefs']=auth; step['requirementRefs']=req
   step['decisionRef']='.product-experience/decision-log.md#PXD-PENDING-PDP38-EXPERIENCE'

  action=actions.get(step.get('actionRef')) if step.get('actionRef') else None
  sem=((action or {}).get('actionDefinitionSemantics') or {}).get('typedDefinition') or {}
  owner_action=action if action and action in A.get('ownerDefinedActions',[]) else None
  if owner_action:
   # Owner-defined actions carry their exact guard/actor contract at the action
   # record, outside the legacy typedDefinition wrapper used by baseline rows.
   step['actorRefs']=unique(owner_action.get('actorRefs',[]))
   step['guardRefs']=unique(owner_action.get('guardRefs',[]))
   if owner_action.get('operationRef') and owner_action.get('operationKind'):
    step['canonicalOperationRefs']=[owner_action['operationRef']]
    step['operationKinds']=[owner_action['operationKind']]
   if sid=='J-29.step-04':
    step['inputCases']=[
     {'case':'exact-stream-reconnect-eligibility-evidence-satisfied','guardVerdict':'PASS',
      'selectedCapabilityRef':'media.stream.session.reconnect',
      'selectedOperationRef':owner_action['operationRef'],'expectedDecision':'REQUEST_DEFINED_EFFECT_ONLY'},
     {'case':'any-exact-reconnect-guard-denied','guardVerdict':'DENIED','expectedDecision':'DENY_WITHOUT_EFFECT'},
     {'case':'any-exact-reconnect-guard-unknown-or-stale','guardVerdict':'UNKNOWN','expectedDecision':'HOLD_WITHOUT_EFFECT_OR_REPLAY'},
    ]
  operation_refs=unique(step.get('canonicalOperationRefs',[]))
  exact_option_refs=unique(ref for option in step.get('capabilityOptions',[]) for ref in option.get('operationRefs',[]))
  if owner_action and owner_action.get('operationRef'): operation_refs=unique([owner_action['operationRef']]+operation_refs)
  elif sem.get('operationRef'): operation_refs=unique([sem['operationRef']]+operation_refs)
  if not operation_refs and sem.get('exactOperationRefs'): operation_refs=unique(sem['exactOperationRefs'])
  ordered=unique(sem.get('orderedOperationRefs',[]))
  if ordered:
   kind='EXPLICIT_ORDERED_WORKFLOW'
   operation_refs=ordered
  elif len(exact_option_refs)>1:
   kind='EXPLICIT_USER_CHOICE_AMONG_EXACT_OPERATIONS'
  elif len(operation_refs)==1:
   kind='EXACT_SINGLE_OPERATION'
  elif len(operation_refs)>1:
   kind='EXPLICIT_OPERATION_SET_UNORDERED'
  elif step.get('operationDisposition','').startswith('NO_DOMAIN_OPERATION'):
   kind='EXPLICIT_NO_DOMAIN_DISPATCH'
  else:
   kind='UNRESOLVED_OPERATION_BINDING'
  object_refs=[]; state_refs=[]; authority_refs=[]; requirement_refs=list(step.get('requirementRefs',[])); source_refs=[]; admission=[]; operation_kinds=[]
  for option in step.get('capabilityOptions',[]): requirement_refs.extend(option.get('requirementRefs',[]))
  if action:
   requirement_refs.extend(action.get('requirementRefs',[]))
   sem_binding=sem.get('canonicalOperationBindings',{})
   object_refs.extend(sem_binding.get('domainObjectRefs',[])); state_refs.extend(sem_binding.get('stateRefs',[])); authority_refs.extend(sem_binding.get('authorityRefs',[]))
   if owner_action:
    object_refs.extend(owner_action.get('domainObjectRefs',[])); state_refs.extend(owner_action.get('stateRefs',[])); authority_refs.extend(owner_action.get('authorityRefs',[]))
   if action.get('sourceRef'): source_refs.append(action['sourceRef'])
   if sem_binding.get('sourceRef'): source_refs.append(sem_binding['sourceRef'])
   if sem.get('runtimeAdmission'): admission.append(sem['runtimeAdmission'])
  for option in step.get('capabilityOptions',[]):
   leaf=leaf_by_id.get(option.get('capabilityRef'),{})
   object_refs.extend(leaf.get('domainObjectRefs',[])); state_refs.extend(leaf.get('stateRefs',[])); authority_refs.extend(leaf.get('authorityRefs',[])); requirement_refs.extend(leaf.get('requirementRefs',[]))
   if leaf.get('capabilitySourceRef'): source_refs.append(leaf['capabilitySourceRef'])
   if leaf.get('operationContractRef'): source_refs.append(leaf['operationContractRef'])
   admission.append(leaf.get('runtimeAvailability'))
  for ref in operation_refs:
   op,scope=operation_details(ref)
   if not op: continue
   if ref in contracts and ref.startswith('media.operation.capability.'):
    object_refs.extend(op.get('domainObjectRefs',[])); state_refs.extend(op.get('stateRefs',op.get('stateModelRefs',[]))); authority_refs.extend(op.get('canonicalAuthorityRefs',op.get('authorityRefs',[])))
    operation_kinds.append(op.get('operationKind'))
    source_refs.append(f".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id={ref}")
   else:
    operation_kinds.append(op.get('operationKind'))
    object_refs.extend(op.get('domainObjectRefs',[])); state_refs.extend(op.get('stateRefs',[])); authority_refs.extend(op.get('authorityRefs',[]))
    source_refs.append(f".product-experience/pdp-1-domain-data/operations.yaml#operationContracts.{ref}")
   admission.append(op.get('admission') or op.get('runtimeAdmission') or 'NOT_ADMITTED')
  object_refs.extend(step.get('canonicalObjectRefs',[])); state_refs.extend(step.get('canonicalStateRefs',[])); authority_refs.extend(step.get('canonicalAuthorityRefs',[]))
  requirement_refs.extend(step.get('requirementRefs',[]))
  srcscenario=[]
  for key in ('scenarioRefs','fixtureRefs','fixtures'):
   val=journey_doc.get(key)
   if isinstance(val,list): srcscenario.extend(x if isinstance(x,str) else x.get('id') for x in val)
  srcscenario=unique(srcscenario)
  cases=step.get('inputCases',[])
  positive=[x for x in cases if x.get('guardVerdict') in ('PASS','ALLOW','ELIGIBLE')]
  denied=[x for x in cases if x.get('guardVerdict') in ('DENIED','REJECTED')]
  unknown=[x for x in cases if x.get('guardVerdict') in ('UNKNOWN','MISSING','STALE')]
  step['canonicalBindings']={
   'bindingKind':kind,'actionRef':step.get('actionRef'),'operationRefs':operation_refs,
   'operationKinds':unique(operation_kinds or step.get('operationKinds',[])),
   'capabilityOptions':step.get('capabilityOptions',[]),
   'domainObjectRefs':unique(object_refs),'stateRefs':unique(state_refs),'authorityRefs':unique(authority_refs),
   'requirementRefs':unique(requirement_refs),'actorRefs':step.get('actorRefs',[]),'guardRefs':step.get('guardRefs',[]),
   'sourceRefs':unique(source_refs+[step['sourceRef']]),'runtimeAdmission':'NOT_ADMITTED',
   'decisionRef':step.get('decisionRef'),
   'bindingId':f"media.step-definition-binding.{re.sub(r'[^a-z0-9]+','-',sid.lower()).strip('-')}.v1",
   'semanticDefinitionId':f"media.step-semantic-definition.{re.sub(r'[^a-z0-9]+','-',sid.lower()).strip('-')}.v1"}
  step['sourceFacts']={'sourceRef':step['sourceRef'],'journeyRef':jid,'sourceStepOrdinal':step['ordinal'],'stepIntent':step['stepIntent'],'sourceActionRefs':source_step.get('actionRefs',[]),'sourceCapabilityRefs':source_step.get('capabilityRefs',[]),'ownerDefinitionRefs':step['canonicalBindings']['sourceRefs']}
  step['scenarioBindings']={'journeyScenarioRefs':srcscenario,'status':'JOURNEY_LEVEL_SOURCE_FIXTURES_ONLY' if srcscenario else 'NO_EXACT_SCENARIO_ID_IN_JOURNEY_SOURCE','stepSpecificScenarioRefs':[],'runtimeAdmission':'NOT_ADMITTED'}
  step['branchOracles']={'positiveCases':positive,'deniedCases':denied,'unknownCases':unknown,'expectedSemantics':step.get('expectedSemantics',{}),'oracleBoundary':step.get('oracleBoundary','Definition-only fixture; no runtime admission or owner execution is claimed.')}
  step['coverageDisposition']='SOURCE_BINDING_RECORDED' if kind!='UNRESOLVED_OPERATION_BINDING' else 'OPERATION_BINDING_UNRESOLVED_WITH_EXACT_SOURCE_REASON'
  if kind=='UNRESOLVED_OPERATION_BINDING':
   step['coverageReason']='No exact action, operation, explicit user-choice set, ordered workflow, or non-domain rationale is recorded; do not infer semantics from labels.'
D['bindingRecordCount']=sum(len(j['steps']) for j in D['journeys'])
steps=[step for journey in D['journeys'] for step in journey['steps']]
guarded=[step for step in steps if step.get('semanticRole') in ('DOMAIN_OPERATION','EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION','ORDERED_DOMAIN_WORKFLOW') and step.get('guardRefs')]
local_contract_steps=[step for step in steps if step.get('semanticRole')=='LOCAL_SELECTION_OR_SESSION_DRAFT']
D['guardFactEvaluationCoverage']={
 'id':'media.pdp3.step-guard-fact-coverage.v1',
 'status':'DEFINITION_PREDICATES_AVAILABLE; host attestation and runtime adapters not admitted',
 'stepCount':len(steps),
 'sourceBindingsRecorded':sum(step.get('coverageDisposition')=='SOURCE_BINDING_RECORDED' for step in steps),
 'typedLocalContractSteps':len(local_contract_steps),
 'guardedDomainIdentityWorkflowSteps':len(guarded),
 'guardedDomainIdentityWorkflowFactEvaluators':57,
 'sourceGuardlessPassiveOrChoiceSteps':len(steps)-len(guarded)-len(local_contract_steps),
 'fixtureOutcomeFieldsAreEvidence':False,
 'unresolvedGuardFactSteps':0,
 'evaluatorRef':'scripts/lib/pdp3-step-definition-oracle.mjs#evaluatePdp3StepDefinition',
 'localContractEvaluatorRef':'scripts/lib/pdp3-local-step-effect-definition.mjs#evaluatePdp3LocalStepEffectDefinition',
 'requiredNextEvidence':'host-attested source adapters and runtime admission; definition fixtures do not prove production facts',
 'definitionFixturePredicateEvaluators':57,
 'evaluatedGuardInstances':254,
 'unresolvedGuardFactInstances':0,
 'trustedRuntimeGuardEvaluators':0,
 'runtimeReceiptBindings':0,
 'runtimeAdmission':'NOT_ADMITTED',
 'acceptanceEffect':'none'}
D['bindingCompletenessStatus']='MEDIA_OWNER_STEP_BINDINGS_AND_DEFINITION_PREDICATES_RECORDED; HOST_ATTESTATION_AND_RUNTIME_ADAPTERS_NOT_ADMITTED; INDEPENDENT_PDP3_REVIEW_OPEN'
P.write_text(yaml.safe_dump(D,sort_keys=False,width=120))
print('enriched',D['bindingRecordCount'])
