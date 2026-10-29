from pathlib import Path
import json, hashlib, subprocess, sys
root=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[2]
repo=sys.argv[2] if len(sys.argv)>2 else ('ghatana-media' if (root/'.product-experience/surfaces/media-physical-topology.v1.json').exists() else 'ghatana-runtime')
def read_json(rel): return json.loads((root/rel).read_text())
def git(*args): return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
commit=git('rev-parse','HEAD')
def local_path(ref):
 ref=ref.split('#',1)[0]
 if ref.startswith('../ghatana-lifecycle/'):
  return root.parent/'ghatana-lifecycle'/ref.removeprefix('../ghatana-lifecycle/')
 if ref.startswith('../ghatana/'):
  return root.parent/'ghatana'/ref.removeprefix('../ghatana/')
 if ref.startswith('ghatana-lifecycle/'):
  return root.parent/'ghatana-lifecycle'/ref.removeprefix('ghatana-lifecycle/')
 return root/ref
def exists_ref(ref): return local_path(ref).exists()
def ref_strings(xs):
 out=[]
 for x in xs:
  if isinstance(x,str) and x: out.append(x)
  elif isinstance(x,dict):
   for k in ('path','contractRef','sourceRef','schemaRef'):
    if isinstance(x.get(k),str): out.append(x[k])
 return out
def hash_path(path):
 if path.is_file(): return hashlib.sha256(path.read_bytes()).hexdigest(), 'file'
 if path.is_dir():
  h=hashlib.sha256()
  for child in sorted((x for x in path.rglob('*') if x.is_file() and '.git' not in x.parts),key=lambda x:x.relative_to(path).as_posix()):
   h.update(child.relative_to(path).as_posix().encode()); h.update(b'\0'); h.update(child.read_bytes()); h.update(b'\0')
  return h.hexdigest(),'directory-tree'
 return None,None
def file_refs(refs):
 out={}
 for ref in ref_strings(refs):
  base=ref.split('#',1)[0].rstrip('/')
  p=local_path(base)
  if p.is_file():
   out[base]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
  elif p.is_dir():
   for child in sorted((x for x in p.rglob('*') if x.is_file() and '.git' not in x.parts),key=lambda x:x.relative_to(p).as_posix()):
    relative=child.relative_to(p).as_posix()
    pin=f'{base}/{relative}' if base else relative
    out[pin]={'sha256':hashlib.sha256(child.read_bytes()).hexdigest()}
 return [{'path':p,**h} for p,h in sorted(out.items())]
def uniq(xs):
 out=[]; seen=set()
 for x in xs:
  if not x: continue
  key=json.dumps(x,sort_keys=True) if isinstance(x,(dict,list)) else x
  if key not in seen: seen.add(key); out.append(x)
 return out
def declared_refs(value):
 out=[]
 if isinstance(value,dict):
  for key,item in value.items():
   if 'ref' in key.lower() or key.lower() in ('path','paths'):
    if isinstance(item,str) and exists_ref(item): out.append(item)
    elif isinstance(item,list): out.extend(ref for ref in item if isinstance(ref,str) and exists_ref(ref))
   out.extend(declared_refs(item))
 elif isinstance(value,list):
  for item in value: out.extend(declared_refs(item))
 return out
profile={
 'library': {'identity':'required','purposeAndScope':'required','publicInterface':'required','dataSemantics':'required','behaviorAndErrors':'required','dependenciesAndComposition':'required','securityAndPrivacy':'conditional','resourceAndObservability':'conditional','accessibilityAndInternationalization':'not-applicable','compatibilityAndEvolution':'required','staticValidation':'required'},
 'service': {'identity':'required','purposeAndScope':'required','operationsRequestsResultsErrors':'required','dataSemantics':'required','behaviorAndIdempotency':'required','dependenciesAndComposition':'required','authorizationAndTenancy':'required','securityAndPrivacy':'required','resourceCancellationTimeouts':'conditional','healthAndTelemetry':'conditional','accessibilityAndInternationalization':'not-applicable','compatibilityAndEvolution':'required','staticValidation':'required'},
 'ui': {'identity':'required','purposeAndScope':'required','routesActionsState':'required','dataInterfacesAndErrors':'required','accessRules':'required','securityAndPrivacy':'conditional','accessibilityAndInternationalization':'required','resourceAndObservability':'conditional','compatibilityAndEvolution':'required','staticValidation':'required'},
 'support': {'identity':'required','purposeAndScope':'required','publicInterface':'conditional','dataSemantics':'conditional','behaviorAndErrors':'conditional','dependenciesAndComposition':'required','securityAndPrivacy':'conditional','resourceAndObservability':'conditional','accessibilityAndInternationalization':'not-applicable','compatibilityAndEvolution':'conditional','staticValidation':'required'},
 'composition': {'identityAndOwners':'required','directMeaningAndBoundaries':'required','childrenAndContainment':'required','crossChildContracts':'conditional','dependencies':'required','inheritedVsDirectResponsibilities':'required','securityAndPrivacy':'conditional','resourceAndObservability':'conditional','compatibilityAndEvolution':'conditional','staticValidation':'required'},
 'repository': {'identityAndOwners':'required','repositoryPurposeAndBoundary':'required','physicalAndLogicalMembership':'required','externalDependencies':'conditional','securityAndPrivacy':'conditional','buildCompatibility':'conditional','staticValidation':'required'}
}
applicability_policy_ref='../ghatana-lifecycle/config/closure/contract-applicability.json'
applicability_policy=json.loads((root.parent/'ghatana-lifecycle/config/closure/contract-applicability.json').read_text())
def canonical_dimensions(profile_ids, profile_details, authorities, schemas, interfaces, decisions):
 required=set(); conditional={}
 for profile_id in profile_ids:
  profile_doc=applicability_policy['profiles'][profile_id]
  required.update(profile_doc['requiredDimensions'])
  conditional.update(profile_doc.get('conditionalDimensions',{}))
 sources=uniq([f'{applicability_policy_ref}#/profiles/{profile_id}' for profile_id in profile_ids]+authorities[:3]+schemas[:2]+interfaces[:3])
 rows=[]
 for dimension in applicability_policy['dimensions']:
  if dimension in required:
   applicability='required'; rationale=f'Required by canonical capability profile(s): {", ".join(profile_ids)}.'
  elif dimension in conditional:
   decision=decisions.get(dimension,{})
   applicability='required' if decision.get('applies') else 'not-applicable'
   rationale=decision.get('rationale') or (f'Profile criterion is not met: {conditional[dimension]}; the cited owning source does not assign this responsibility directly to this surface.' if applicability=='not-applicable' else f'Profile criterion is established by source evidence and is required for this surface: {conditional[dimension]}')
  else:
   applicability='not-applicable'; rationale=f'Canonical profile(s) {", ".join(profile_ids)} do not require this dimension for the declared capability boundary.'
  rows.append({'dimension':dimension,'applicability':applicability,'rationale':rationale,'sourceRefs':sources})
 return rows

def conditional_decisions(profile_ids, refs, *, has_children=False, direct_interface=False, direct_data=False, direct_behavior=False, trust_boundary=False, quality_obligation=False):
 decisions={}
 for profile_id in profile_ids:
  profile_doc=applicability_policy['profiles'][profile_id]
  for dimension,criterion in profile_doc.get('conditionalDimensions',{}).items():
   if dimension in decisions: continue
   applies={'composition':has_children,'public-interface':direct_interface,'data-semantics':direct_data,'behavior':direct_behavior,'security-and-privacy':trust_boundary,'quality-constraints':quality_obligation}.get(dimension,False)
   evidence=', '.join(refs[:4]) or 'the source-owned surface record'
   rationale=(f'The owner-source condition is met by {evidence}; this direct responsibility is required for the declared contract. Profile criterion: {criterion}' if applies
     else f'Not applicable at this surface: the cited owner sources {evidence} do not declare the conditional direct responsibility. Profile criterion: {criterion}')
   decisions[dimension]={'applies':applies,'rationale':rationale}
 return decisions

def make(surface_id, repo_id, kind, owners, authorities, schemas, interfaces, deps, dims, findings, validation, disposition, extra=None):
 profile_ids=(extra or {}).get('applicabilityProfileIds',[])
 decisions=(extra or {}).get('conditionalApplicabilityDecisions',{})
 applicable=canonical_dimensions(profile_ids,dims,authorities,schemas,interfaces,decisions) if profile_ids else dims
 dimension_refs=[ref for item in applicable if isinstance(item,dict) for ref in item.get('sourceRefs',[])]
 refs=uniq(authorities+schemas+interfaces+ref_strings(deps)+dimension_refs+declared_refs(owners)+declared_refs(extra or {}))
 rec={'surfaceId':surface_id,'repositoryId':repo_id,'surfaceKind':kind,'contractOwners':owners,
 'sourceAuthorityRefs':uniq(authorities),'contractSchemaRefs':uniq(schemas),'publicInterfaceRefs':uniq(interfaces),
 'requiredDependencyRefs':uniq(deps),'applicableContractDimensions':applicable,'definitionFindings':findings,
 'staticValidationResult':validation,'sourceFingerprint':{'sourceCommit':commit,'workingTreeState':'HEAD plus per-file SHA-256; may include uncommitted source changes','files':file_refs(refs)},
 'definitionDisposition':disposition}
 if profile_ids: rec['applicabilityProfileIds']=profile_ids
 if extra: rec.update(extra)
 # Preserve resolution state even for directory/document references whose individual files are not hashed.
 rec['resolvedSourceRefs']=[{'ref':ref,'exists':exists_ref(ref)} for ref in ref_strings(refs)]
 return rec
surfaces=[]
inventory_dispositions=[]
if repo=='ghatana-media':
 topology_path='.product-experience/surfaces/media-physical-topology.v1.json'
 topo=read_json(topology_path)
 p0='.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md'
 for c in topo['manifestCandidates']:
  disp=c['disposition']
  if disp!='PHYSICAL':
   candidate_refs=[topology_path,'.product-experience/surface-registry.yaml',c['manifestPath']] + ([c['publicBoundaryRef']] if c.get('publicBoundaryRef') else [])
   candidate_refs += [ref for row in c.get('phaseApplicability',{}).values() for ref in ([row.get('authorityRef')] if row.get('authorityRef') else []) + row.get('authorityRefs',[]) ]
   inventory_dispositions.append({'candidateId':c['surfaceId'],'repositoryId':repo,'manifestCandidate':True,'inventoryClassification':'support-only' if disp=='SUPPORT_ONLY' else 'subsumed','sourceDisposition':disp,'sourcePath':c['sourcePath'],'manifestPath':c['manifestPath'],'ownerId':c.get('owner'),'publicBoundaryRef':c.get('publicBoundaryRef'),'declaredConsumers':c.get('consumerSurfaceRefs',[]),'consumerMappingState':c.get('consumerMappingState'),'dispositionRationale':c.get('dispositionRationale',''),'sourceAuthorityRefs':uniq(candidate_refs),'sourceFingerprint':{'sourceCommit':commit,'files':file_refs(candidate_refs)},'resolvedSourceRefs':[{'ref':ref,'exists':exists_ref(ref)} for ref in ref_strings(candidate_refs)]})
   continue
  kind='PHYSICAL'
  surface_profile='library' if c['buildSystem'] in ('gradle','pnpm-workspace','cargo') else 'support'
  if disp!='PHYSICAL': surface_profile='support'
  if 'ui' in c['sourcePath'] or 'experience-explorer' in c['sourcePath']: surface_profile='ui'
  if c['sourcePath']=='launcher' or c['sourcePath'].startswith('modules/speech/') or c['sourcePath'].startswith('modules/vision/') or c['sourcePath'].startswith('modules/intelligence/'):
   surface_profile='service'
  phase_refs=[]; p1ids=[]; p0ids=[]; p0reqids=[]; p0families=[]; p0intents=[]; journeys=[]; screens=[]
  for phase,row in c.get('phaseApplicability',{}).items():
   for key in ('authorityRef','operationAuthorityRef','objectAuthorityRef'):
    if row.get(key): phase_refs.append(row[key])
   for key in ('authorityRefs',): phase_refs+=row.get(key,[])
   p0reqids+=row.get('requirementIds',[]); p0families+=row.get('capabilityFamilyIds',[]); p0intents+=row.get('capabilityIntentIds',[])+row.get('intentIds',[]); p0ids+=row.get('requirementIds',[])+row.get('capabilityFamilyIds',[])+row.get('capabilityIntentIds',[])+row.get('intentIds',[])
   p1ids+=row.get('domainObjectIds',[])+row.get('operationIds',[])
   journeys+=row.get('journeyIds',[]); screens+=row.get('screenIds',[])
  auth=[topology_path,'.product-experience/surface-registry.yaml',c['manifestPath']]
  if c.get('publicBoundaryRef'): auth.append(c['publicBoundaryRef'])
  auth+=phase_refs
  interfaces=[]; schemas=[]
  path=c.get('publicBoundaryRef','')
  if path.endswith('.proto'):
   interfaces.append(path); schemas.append(path)
  elif path.endswith('media.yaml') or path.endswith('media.yaml'):
   interfaces.append(path); schemas.append(path)
  elif path.endswith('contracts.ts'):
   interfaces.append(path); schemas.append(path)
  elif path.endswith('operations.ts'): interfaces.append(path)
  elif path.endswith('specification-artifacts.json'): interfaces.append(path)
  elif c['sourcePath']=='launcher':
   interfaces+=['contracts/openapi/media.yaml','config/route-manifest.json','config/provider-manifest.json']; schemas+=['contracts/openapi/media.yaml']
  elif c['sourcePath'].startswith('modules/speech/stt-service'): interfaces.append('modules/speech/stt-service/src/main/proto/stt_service.proto'); schemas.append(interfaces[-1])
  elif c['sourcePath'].startswith('modules/speech/tts-service'): interfaces.append('modules/speech/tts-service/src/main/proto/tts_service.proto'); schemas.append(interfaces[-1])
  elif c['sourcePath'].startswith('modules/vision/vision-service'): interfaces.append('modules/vision/vision-service/src/main/proto/vision_service.proto'); schemas.append(interfaces[-1])
  elif c['sourcePath'].startswith('modules/intelligence/multimodal-service'): interfaces.append('modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto'); schemas.append(interfaces[-1])
  elif c['sourcePath']=='runtime-contracts': interfaces += ['runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java']; schemas+=interfaces[-1:]
  elif c['sourcePath']=='adapters/data-cloud-media':
   interfaces += [
    'adapters/data-cloud-media/CONSUMER_GUIDE.md',
    'adapters/data-cloud-media/src/main/java/com/ghatana/stt/datacloud/DataCloudSttAdapter.java',
    'adapters/data-cloud-media/src/main/java/com/ghatana/audio/video/vision/datacloud/DataCloudVisionAdapter.java',
    'adapters/data-cloud-media/src/main/java/com/ghatana/audio/video/multimodal/datacloud/DataCloudMultimodalAdapter.java',
    'adapters/data-cloud-media/src/main/java/com/ghatana/audio/video/multimodal/datacloud/MediaSemanticObservationProjector.java',
    '../ghatana/services/data-cloud/delivery/api/src/main/java/com/ghatana/datacloud/memory/media/MediaProcessorPort.java',
    'modules/speech/stt-service/src/main/java/com/ghatana/stt/service/PersistentSttService.java',
    'modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/service/PersistentVisionService.java',
    'modules/intelligence/multimodal-service/src/main/java/com/ghatana/audio/video/multimodal/service/PersistentMultimodalService.java'
   ]
  elif c['sourcePath']=='libs/audio-video-ui': interfaces += ['libs/audio-video-ui/package.json','libs/audio-video-ui/src/index.tsx']
  elif c['sourcePath']=='modules/intelligence/ai-voice/libs/ai-voice-ui-react': interfaces += ['modules/intelligence/ai-voice/libs/ai-voice-ui-react/package.json','modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/index.ts']
  elif c['sourcePath']=='providers/aws-postgresql':
   interfaces += ['runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java','runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaTranscriptContracts.java','providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaJobStore.java','providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/S3PostgresqlMediaArtifactStore.java','providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaStreamSessionStore.java']
   schemas += interfaces[:2]
  dimensions=profile[surface_profile].copy()
  profile_id={'library':'library-sdk','service':'http-grpc-service','ui':'ui-application','support':'library-sdk'}[surface_profile]
  if c['sourcePath']=='providers/aws-postgresql': profile_id='provider-adapter'
  profile_ids=['library-sdk','provider-adapter'] if c['sourcePath']=='adapters/data-cloud-media' else [profile_id]
  if c['sourcePath'] in ('libs/audio-video-ui','modules/intelligence/ai-voice/libs/ai-voice-ui-react'): profile_id='library-sdk'
  if p0ids: dimensions['productRequirementTrace']='required'
  else: dimensions['productRequirementTrace']='conditional'
  if p1ids: dimensions['domainAndOperationTrace']='required'
  else: dimensions['domainAndOperationTrace']='conditional'
  if not any('ui' in c['sourcePath'] for _ in [0]): dimensions['accessibilityAndInternationalization']='not-applicable' if surface_profile!='ui' else 'required'
  findings=[]
  provider_mapping=[]
  if c['sourcePath']=='launcher':
   provider_mapping=[{'providerOperationId':'upload','providerSourceRef':'config/provider-manifest.json#/operations/0','httpOperationId':'beginMediaUpload','httpSourceRef':'contracts/openapi/media.yaml#/paths/~1api~1v1~1artifacts~1uploads/post','routeManifestRef':'config/route-manifest.json#/routes/12','inputSchemaRef':'contracts/openapi/media.yaml#/components/schemas/UploadRequest','outputSchemaRef':'contracts/openapi/media.yaml#/components/schemas/UploadSession','mappingSemantics':'Provider capability alias and HTTP operation ID are distinct namespaces; this is an explicit provider-to-HTTP mapping, not identity equivalence.'}]
  deps=[]
  if c['sourcePath']=='adapters/data-cloud-media':
   deps=[
    {'serviceId':'data-cloud-media-processor-port','relationship':'implements-provider-spi','contractRef':'../ghatana/services/data-cloud/delivery/api/src/main/java/com/ghatana/datacloud/memory/media/MediaProcessorPort.java','requiredness':'required'},
    {'serviceId':'data-cloud-delivery-api','relationship':'compile-runtime-dependency','contractRef':'../ghatana/services/data-cloud/delivery/api/build.gradle.kts','requiredness':'required'},
    {'serviceId':'data-cloud-shared-spi','relationship':'compile-runtime-dependency','contractRef':'../ghatana/services/data-cloud/planes/shared-spi/build.gradle.kts','requiredness':'required'},
    {'serviceId':'media-stt-service','relationship':'delegated-modality-service','contractRef':'modules/speech/stt-service/src/main/java/com/ghatana/stt/service/PersistentSttService.java','requiredness':'required'},
    {'serviceId':'media-vision-service','relationship':'delegated-modality-service','contractRef':'modules/vision/vision-service/src/main/java/com/ghatana/audio/video/vision/service/PersistentVisionService.java','requiredness':'required'},
    {'serviceId':'media-multimodal-service','relationship':'delegated-modality-service','contractRef':'modules/intelligence/multimodal-service/src/main/java/com/ghatana/audio/video/multimodal/service/PersistentMultimodalService.java','requiredness':'required'}
   ]
  if disp=='SUPPORT_ONLY': findings.append({'code':'SUPPORT_ONLY','detail':c.get('dispositionRationale','Declared supporting implementation; no separate product contract is inferred.'),'severity':'informational'})
  elif disp=='SUBSUMED': findings.append({'code':'SUBSUMED','detail':c.get('dispositionRationale','Implementation is represented by its owning semantic surface; not counted as a separate closure contract.'),'severity':'informational'})
  if c.get('consumerMappingState') not in (None,'MAPPED') and disp=='PHYSICAL': findings.append({'code':'CONSUMER_MAPPING_UNRESOLVED','detail':str(c.get('consumerMappingState')),'severity':'definition-gap'})
  owners=[{'ownerId':'media-product-semantics','authorityRef':p0},{'ownerId':c.get('owner','unknown'),'authorityRef':c['manifestPath']}]
  profile_ids=profile_ids
  has_ui_children=bool(screens) or c['sourcePath']=='apps/media-experience-explorer'
  direct_ui_composition=has_ui_children and (surface_profile=='ui' or c['sourcePath']=='apps/media-experience-explorer')
  decisions=conditional_decisions(profile_ids,interfaces or auth,has_children=direct_ui_composition,trust_boundary=any(x in ' '.join(interfaces+auth).lower() for x in ('consent','rights','security','policy','tenant','principal')),quality_obligation=any(x in ' '.join(interfaces+auth).lower() for x in ('resource','timeout','deadline','observability','metrics','budget')))
  extra={'applicabilityProfileIds':profile_ids,'conditionalApplicabilityDecisions':decisions,'inventoryDisposition':disp,'inventoryClassification':'active-candidate','manifestCandidate':True,'declaredConsumers':c.get('consumerSurfaceRefs',[]),'mappedRequirementIds':uniq(p0reqids),'mappedCapabilityFamilyIds':uniq(p0families),'mappedCapabilityIntentIds':uniq(p0intents),'mappedDomainOperationIds':uniq(p1ids),'mappedJourneyIds':uniq(journeys),'mappedScreenIds':uniq(screens),'candidateRationale':c.get('dispositionRationale',''),'providerOperationMappings':provider_mapping,'requirementContractCoverage':[{'requirementId':req,'requirementAuthorityRef':next((c['phaseApplicability'].get('PDP-0',{}).get(k) for k in ('authorityRef','authorityRefs') if c['phaseApplicability'].get('PDP-0',{}).get(k)),p0),'contractAuthorityRefs':interfaces or ([c['publicBoundaryRef']] if c.get('publicBoundaryRef') else []),'coverageBasis':'topology candidate association only; does not assert operation-level semantic binding or acceptance'} for req in uniq(p0reqids) ]}
  status='needs-owner-facts' if any(f['code']=='CONSUMER_MAPPING_UNRESOLVED' for f in findings) else ('support-only' if disp=='SUPPORT_ONLY' else ('subsumed' if disp=='SUBSUMED' else ('complete' if disp=='PHYSICAL' else 'inventory-disposition-declared')))
  surfaces.append(make(c['surfaceId'],repo,kind,owners,auth,schemas,interfaces,[],dimensions,findings,{'status':'partial' if any(f['severity']=='definition-gap' for f in findings) else 'source-linked','checks':['matrix source refs and hashes validated']},status,extra))
 for c in topo['compositions']:
  kind='REPOSITORY' if c['kind']=='REPOSITORY_ROOT' else 'COMPOSITION'
  prof=profile['repository' if kind=='repository' else 'composition']
  auth=[topology_path]+[r for row in c.get('phaseApplicability',{}).values() for r in ([row.get('authorityRef')] if row.get('authorityRef') else [])+row.get('authorityRefs',[])]
  deps=c.get('dependencies',[])
  child_by_id={x['surfaceId']:x for x in topo['manifestCandidates']}
  child_ifaces=[]; child_contract_refs=[]
  for child_id in c.get('children',[]):
   child=child_by_id.get(child_id)
   if child:
    refs=[]
    if child.get('publicBoundaryRef') and not child.get('publicBoundaryRef','').endswith('/'):
     refs=[child['publicBoundaryRef']]
    if refs: child_ifaces+=refs
    child_contract_refs.append({'surfaceId':child_id,'manifestRef':child.get('manifestPath'),'publicBoundaryRef':child.get('publicBoundaryRef'),'publicInterfaceRefs':refs,'disposition':child.get('disposition')})
   else:
    child_contract_refs.append({'surfaceId':child_id,'compositionRef':next((x['surfaceId'] for x in topo['compositions'] if x['surfaceId']==child_id),None)})
  findings=[]
  if c.get('status')=='MEDIA_AUTHORED_PROVISIONAL_LIFECYCLE_SCHEMA_PENDING': findings.append({'code':'LIFECYCLE_PROJECTION_PENDING','detail':'Media-authored composition is discovery metadata; it is not a canonical Closure descriptor or phase outcome.','severity':'informational'})
  profile_ids=['composition-logical']
  decisions=conditional_decisions(profile_ids,[topology_path],has_children=bool(c.get('children')),direct_behavior=bool(c.get('crossChildObligations')))
  extra={'applicabilityProfileIds':profile_ids,'conditionalApplicabilityDecisions':decisions,'children':c.get('children',[]),'candidateSurfaceIds':[x['surfaceId'] for x in topo['manifestCandidates']],'candidateDispositionCounts':{v:sum(1 for x in topo['manifestCandidates'] if x['disposition']==v) for v in sorted({x['disposition'] for x in topo['manifestCandidates']})},'childContractRefs':child_contract_refs,'containmentSemantics':c.get('containmentSemantics'),'membershipSemantics':c.get('membershipSemantics'),'crossChildObligations':c.get('crossChildObligations',[]),'compositionSourceStatus':c.get('status'),'inventoryDisposition':'declared-composition'}
  surfaces.append(make(c['surfaceId'],repo,kind,[{'ownerId':c.get('canonicalOwner','media'),'authorityRef':topology_path}],auth,[],uniq(child_ifaces),deps,prof,findings,{'status':'source-linked','checks':['composition children and cross-child obligations linked']},'complete',extra))
 # Lifecycle-facing aggregate descriptor is one logical envelope, distinct from the topology root.
 cp='config/closure/media-product-definition/surface.json'
 c=read_json(cp)
 operation_source='.product-experience/pdp-1-domain-data/operations.yaml'
 product_interfaces=[operation_source,'contracts/openapi/media.yaml','config/route-manifest.json','modules/speech/stt-service/src/main/proto/stt_service.proto','modules/speech/tts-service/src/main/proto/tts_service.proto','modules/vision/vision-service/src/main/proto/vision_service.proto','modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto','libs/audio-video-types/src/contracts.ts','libs/audio-video-client/src/operations.ts','libs/audio-video-client/src/index.ts','.product-experience/pdp-3-product-experience/action-registry.yaml','.product-experience/pdp-3-product-experience/api-experience-mapping.yaml','.product-experience/pdp-3-product-experience/cli-command-registry.yaml','.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml','.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml','.product-experience/pdp-3-product-experience/events/event-registry.yaml']
 import re
 op_text=(root/operation_source).read_text()
 proposed_ops=uniq(re.findall(r'^    operationId: (media\.operation\.[A-Za-z0-9_.-]+)$',op_text,re.M))
 slice_section=op_text[op_text.find('individualOperationContracts:'):]
 slice_blocks=re.findall(r'(?ms)^    - id: (media\.operation-slice\.[^\n]+)(.*?)(?=^    - id: |^agentToolRuntimeDispositions:|\Z)',slice_section)
 individual_contracts=[]
 for index,(record_id,body) in enumerate(slice_blocks):
  row={'id':record_id,'recordRef':f'{operation_source}#individualOperationContracts/records/{index}'}
  current=None; wire={}; owner={}
  for line in body.splitlines():
   if re.match(r'^      [A-Za-z][\w-]*:',line):
    current=line.strip().split(':',1)[0]; key=current; value=line.strip().split(':',1)[1].strip()
    if key in ('sourceOperation','sourceRef','status','ownerDecisionRef','actionBindingDisposition') and value: row[key]=value
   elif re.match(r'^        [A-Za-z][\w-]*:',line):
    key=line.strip().split(':',1)[0]; value=line.strip().split(':',1)[1].strip()
    if current=='wireBinding' and key in ('method','path','operationId','successStatus','responseSchema') and value: wire[key]=value
    if current=='ownerSemantics' and key=='reviewStatus' and value: owner[key]=value
  if wire: row['wireBinding']=wire
  if owner: row['ownerSemantics']=owner
  individual_contracts.append(row)
 import yaml
 openapi=yaml.safe_load((root/'contracts/openapi/media.yaml').read_text())
 http_operations=[]
 for path,methods in openapi.get('paths',{}).items():
  for method,op in methods.items():
   if method.lower() in {'get','put','post','delete','patch','options','head','trace'} and isinstance(op,dict) and op.get('operationId'):
    http_operations.append({'operationId':op['operationId'],'method':method.upper(),'path':path,'contractRef':f"contracts/openapi/media.yaml#/paths/{path.replace('~','~0').replace('/','~1')}/{method}"})
 proto_paths=product_interfaces[3:7]
 rpc_inventory=[]
 for proto in proto_paths:
  for rpc in re.findall(r'^\s*rpc\s+([A-Za-z0-9_]+)\s*\(',(root/proto).read_text(),re.M): rpc_inventory.append({'rpc':rpc,'contractRef':f'{proto}#rpc/{rpc}'})
 product_profile_ids=['product']
 product_decisions=conditional_decisions(product_profile_ids,[operation_source,topology_path],has_children=True,direct_interface=True,direct_data=True,direct_behavior=True,trust_boundary=True,quality_obligation=True)
 surfaces.append(make(c['id'],repo,'LOGICAL',[{'ownerId':','.join(c['owner'].get('implementationUnitIds',[])),'authorityRef':cp}], [cp,'config/closure/media-product-definition/phase-program.json','config/closure/media-product-definition/phase-binding.json',operation_source], ['../ghatana-lifecycle/libs/evidence-contracts/schemas/closure/closure-surface.schema.json','contracts/openapi/media.yaml',*proto_paths,'libs/audio-video-types/src/contracts.ts'],product_interfaces,c.get('externalContractDependencyIds',[]),profile['composition'],[{'code':'PDP1_OPERATION_SUMMARY_PROPOSAL_ONLY','detail':'The operation-family source remains proposal-only. Six exact HTTP operation-slice wire bindings and all 16 individual-operation source records are enumerated with their original statuses; those slices do not promote the broader proposal or establish unreviewed cross-channel equivalence.','sourceRef':operation_source,'severity':'definition-status-separate-from-acceptance'}],{'status':'source-linked','checks':['pnpm check:physical-topology PASS','OpenAPI/RPC inventories enumerated; semantic parity remains proposal-only']},'complete',{'applicabilityProfileIds':product_profile_ids,'conditionalApplicabilityDecisions':product_decisions,'declaredClosureDependencies':c.get('closureDependencies',[]),'phaseProgramRef':c.get('phaseProgramRef'),'phaseBindingRef':c.get('phaseBindingRef'),'proposalOperationIds':proposed_ops,'individualOperationContractRecords':individual_contracts,'individualOperationContractCount':len(individual_contracts),'proposalOperationSourceRef':operation_source,'proposalScopeStatus':'proposal-only; no semantic acceptance implied','publicHttpOperationInventory':http_operations,'publicGrpcRpcInventory':rpc_inventory,'interfaceMappingDisposition':'six exact HTTP operation-slice wire bindings and all individual source records are projected with original statuses; broader family and cross-channel semantic equivalence remain proposal-only and owner review remains pending'}))
else:
 reg=read_json('config/runtime-service-registry.json'); source=read_json('config/service-contract-source.json');
 for file in sorted((root/'config/closure/surfaces').glob('*.json')):
  rel=file.relative_to(root).as_posix(); c=json.loads(file.read_text()); ext=c.get('extensions',{}).get('ghatana.runtime',{}); sid=ext.get('registryId')
  if sid=='data-cloud-api': service='data-cloud'
  elif sid=='data-cloud-sdk': service='data-cloud'
  elif sid=='data-cloud-web': service='data-cloud'
  elif sid=='aep-api' or sid=='aep-runtime': service='aep'
  else: service=sid.removesuffix('-api') if sid else None
  row=reg['registry'].get(service,{})
  cfg=source['serviceConfigs'].get(service,{})
  contract=row.get('manifestPath')
  api=cfg.get('apiContracts',{}).get('primary',{})
  interface=api.get('path')
  surface_spec=next((x for x in row.get('surfaces',[]) if x.get('surfaceId')==sid),{})
  public_interfaces=[interface] if interface else []
  contract_schemas=[contract] if contract else []
  if ext.get('type')=='sdk':
   public_interfaces=['services/data-cloud/delivery/sdk/README.md','services/data-cloud/delivery/sdk/src/main/java/com/ghatana/datacloud/sdk/capability/CapabilityDiscoveryClient.java']
   contract_schemas += [interface] if interface else []
  elif ext.get('type')=='ui':
   public_interfaces=['services/data-cloud/delivery/ui/package.json','services/data-cloud/delivery/ui/src/routes.tsx','services/data-cloud/delivery/ui/src/api/index.ts','services/data-cloud/delivery/ui/src/generated/api/index.ts','services/data-cloud/delivery/ui/src/contracts/generated/index.ts','services/data-cloud/delivery/ui/config/route-manifest.json']
   contract_schemas += [interface] if interface else []
  deps=[]; conditional_deps=[]
  for dep,depdesc in cfg.get('dependencies',{}).items():
   health=cfg.get('dependencyHealth',{}).get('dependencies',{}).get(dep,{})
   entry={'serviceId':dep,'relationship':depdesc.get('relationship','declared'),'contractRef':depdesc.get('contractPath',''),'requiredness':'required' if health.get('required') is True else ('conditional' if health.get('required') is False else 'declared; requiredness unspecified')}
   (deps if entry['requiredness']=='required' else conditional_deps).append(entry)
  owner=cfg.get('owner') or row.get('metadata',{}).get('owner') or service
  dimensions=profile['ui' if ext.get('type')=='ui' else ('library' if ext.get('type')=='sdk' else 'service')].copy()
  runtime_profile_id='ui-application' if ext.get('type')=='ui' else ('library-sdk' if ext.get('type')=='sdk' else ('event-stream-processor' if service=='event-plane' else 'http-grpc-service'))
  runtime_children=bool(c.get('composition',{}).get('childSurfaceIds',[]))
  runtime_decisions=conditional_decisions([runtime_profile_id],[rel,contract or '',interface or ''],has_children=runtime_children)
  auth=['config/runtime-service-registry.json','config/service-contract-source.json',rel]
  if contract: auth.append(contract)
  if interface: auth.append(interface)
  schemas=contract_schemas
  interfaces=public_interfaces
  findings=[]
  disposition='complete'
  if service=='media':
   findings.append({'code':'HISTORICAL_MEDIA_SOURCE_BINDING','detail':'The monorepo registry and Closure descriptor retain the historical services/media path as provenance; standalone ghatana-media is the source implementation owner pending operational cutover.','severity':'owner-fact-unresolved'})
   disposition='needs-owner-facts'
  # Source declarations/Closure mapping are explicit; validation outcome is recorded independently below.
  validation={'status':'not-yet-validated','checks':[]}
  requirements=[{'requirementId':r.get('id'),'status':r.get('status'),'statement':r.get('statement'),'designRefs':r.get('designRefs',[]),'implementationRefs':r.get('implementationRefs',[]),'testRefs':r.get('testRefs',[]),'staticBlockers':r.get('staticBlockers',[]),'contractRefs':public_interfaces,'coverageBasis':'service-level trace only; not accepted runtime proof or exhaustive operation mapping'} for r in cfg.get('requirements',[])]
  public_operations=[]
  if interface and ext.get('type') not in ('sdk','ui'):
   try:
    import yaml
    api_doc=yaml.safe_load((root/interface).read_text())
    for path,methods in api_doc.get('paths',{}).items():
     for method,op in methods.items():
      if method.lower() in {'get','put','post','delete','patch','options','head','trace'} and isinstance(op,dict) and op.get('operationId'):
       public_operations.append({'operationId':op['operationId'],'method':method.upper(),'path':path,'contractRef':f"{interface}#/paths/{path.replace('~','~0').replace('/','~1')}/{method}"})
   except Exception: pass
  surfaces.append(make(c['id'],repo,c['kind'],[{'ownerId':owner,'authorityRef':'config/service-contract-source.json#serviceConfigs.'+str(service)}],auth,schemas,interfaces,deps,dimensions,findings,validation,disposition,{'closureDescriptorRef':rel,'registryId':sid,'serviceId':service,'declaredImplementationPath':ext.get('path'),'registeredSurfacePath':surface_spec.get('path'),'registeredSurfaceType':surface_spec.get('type'),'phaseProgramRef':c.get('phaseProgramRef'),'phaseBindingRef':c.get('phaseBindingRef'),'serviceContractProjectionRef':contract,'declaredPublicContractRef':interface,'publicOperations':public_operations,'declaredClosureDependencies':c.get('closureDependencies',[]),'externalContractDependencyIds':c.get('externalContractDependencyIds',[]),'conditionalDependencyRefs':conditional_deps,'applicabilityProfileIds':[runtime_profile_id],'conditionalApplicabilityDecisions':runtime_decisions,'requirementContractCoverage':{'requirementAuthorityRef':'config/service-contract-source.json#serviceConfigs.'+str(service),'requirementIds':[r.get('id') for r in cfg.get('requirements',[])],'requirements':requirements,'contractAuthorityRefs':interfaces,'coverageBasis':'service-owned requirement text and refs are linked to the surface contract; only the named API operation list is enumerated; this does not claim implementation evidence or acceptance'}}))
# ensure no duplicate ids and direct declaration order reproducible
ids=[s['surfaceId'] for s in surfaces]
if len(ids)!=len(set(ids)): raise SystemExit('duplicate surface identities in input')
external_commits=[]
external_repositories={}
all_source_refs=[ref for surface in surfaces for ref in ref_strings(surface['sourceAuthorityRefs']+surface['contractSchemaRefs']+surface['publicInterfaceRefs']+[d['sourceRefs'] for d in surface.get('applicableContractDimensions',[]) if isinstance(d,dict)])]
if any(ref.startswith(('../ghatana-lifecycle/','ghatana-lifecycle/')) for ref in all_source_refs): external_repositories['ghatana-lifecycle']=root.parent/'ghatana-lifecycle'
if any(ref.startswith('../ghatana/') for ref in all_source_refs): external_repositories['ghatana']=root.parent/'ghatana'
for repository_id, ext in external_repositories.items():
 try: external_commits.append({'repositoryId':repository_id,'sourceCommit':subprocess.check_output(['git','-C',str(ext),'rev-parse','HEAD'],text=True).strip()})
 except Exception: pass
out={'schemaVersion':'contract-definition-surface-matrix.v1','repositoryId':repo,'sourceCommit':commit,'externalSourceCommits':external_commits,'surfaceCount':len(surfaces),'inventoryDispositionCount':len(inventory_dispositions),'manifestCandidateCount':len(inventory_dispositions)+sum(1 for x in surfaces if x.get('manifestCandidate')),'inventoryEntryCount':len(surfaces)+len(inventory_dispositions),'surfaces':surfaces,'inventoryDispositions':inventory_dispositions}
(root/'.ghatana/definition/surface-matrix.json').write_text(json.dumps(out,indent=2,ensure_ascii=False)+'\n')
print(f'wrote {len(surfaces)} records at {root}/.ghatana/definition/surface-matrix.json; source commit={commit}')
