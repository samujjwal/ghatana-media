#!/usr/bin/env python3
"""Validate the non-authoritative contract-definition projection and exercise adverse cases."""
from pathlib import Path
import copy, hashlib, json, subprocess, sys
root=Path(__file__).resolve().parents[2]
repo='ghatana-media' if (root/'.product-experience/surfaces/media-physical-topology.v1.json').exists() else 'ghatana-runtime'
matrix_path=root/'.ghatana/definition/surface-matrix.json'
ALLOWED_CLOSURE_FIELDS={'schemaVersion','id','kind','title','owner','intent','assurance','phaseProgramRef','phaseBindingRef','composition','closureDependencies','externalContractDependencyIds','obligationIds','extensions'}

def resolve_ref(ref):
 rel=ref.split('#',1)[0]
 if rel.startswith('../ghatana-lifecycle/'):
  return root.parent/'ghatana-lifecycle'/rel.removeprefix('../ghatana-lifecycle/')
 if rel.startswith('../ghatana/'):
  return root.parent/'ghatana'/rel.removeprefix('../ghatana/')
 if rel.startswith('ghatana-lifecycle/'):
  return root.parent/'ghatana-lifecycle'/rel.removeprefix('ghatana-lifecycle/')
 return root/rel

_DIGEST_CACHE={}
def source_digest(path):
 key=str(path.resolve())
 if key in _DIGEST_CACHE: return _DIGEST_CACHE[key]
 if path.is_file():
  value=hashlib.sha256(path.read_bytes()).hexdigest(); _DIGEST_CACHE[key]=value; return value
 if path.is_dir():
  digest=hashlib.sha256()
  for child in sorted((x for x in path.rglob('*') if x.is_file() and '.git' not in x.parts),key=lambda x:x.relative_to(path).as_posix()):
   digest.update(child.relative_to(path).as_posix().encode()); digest.update(b'\0'); digest.update(child.read_bytes()); digest.update(b'\0')
  value=digest.hexdigest(); _DIGEST_CACHE[key]=value; return value
 return None

def declared_refs(value):
 out=[]
 if isinstance(value,dict):
  for key,item in value.items():
   if 'ref' in key.lower() or key.lower() in ('path','paths'):
    if isinstance(item,str) and resolve_ref(item).exists(): out.append(item)
    elif isinstance(item,list): out.extend(ref for ref in item if isinstance(ref,str) and resolve_ref(ref).exists())
   out.extend(declared_refs(item))
 elif isinstance(value,list):
  for item in value: out.extend(declared_refs(item))
 return out

def uncovered_refs(row):
 pins=[resolve_ref(item['path']).resolve() for item in row.get('sourceFingerprint',{}).get('files',[]) if resolve_ref(item.get('path',''))]
 errors=[]
 for ref in set(declared_refs(row)):
  target=resolve_ref(ref)
  if not target.exists(): continue
  target=target.resolve()
  covered=target in pins if target.is_file() else any(pin.is_relative_to(target) for pin in pins)
  if not covered: errors.append(ref)
 return errors

def actual_owner(surface):
 sid=surface.get('surfaceId','')
 if repo=='ghatana-media':
  topo=json.loads((root/'.product-experience/surfaces/media-physical-topology.v1.json').read_text())
  found=next((x for x in topo['manifestCandidates'] if x['surfaceId']==sid),None)
  if found: return found.get('owner')
  comp=next((x for x in topo['compositions'] if x['surfaceId']==sid),None)
  if comp: return comp.get('canonicalOwner')
  if sid=='media.product-definition':
   d=json.loads((root/'config/closure/media-product-definition/surface.json').read_text())
   return ','.join(d['owner'].get('implementationUnitIds',[]))
 else:
  c=json.loads((root/surface['closureDescriptorRef']).read_text())
  reg=json.loads((root/'config/runtime-service-registry.json').read_text())
  return reg['registry'].get(surface.get('serviceId'),{}).get('metadata',{}).get('owner')
 return None

def errors_for(m):
 errors=semantic_coverage_errors(m)
 if m.get('schemaVersion')!='contract-definition-surface-matrix.v1': errors.append('malformed schema version')
 rows=m.get('surfaces')
 if not isinstance(rows,list): return errors+['surfaces is not a list']
 if m.get('surfaceCount')!=len(rows): errors.append('surface count stale')
 if m.get('inventoryEntryCount')!=len(rows)+len(m.get('inventoryDispositions',[])): errors.append('inventory entry denominator mismatch')
 if m.get('inventoryDispositionCount')!=len(m.get('inventoryDispositions',[])): errors.append('inventory disposition count mismatch')
 if m.get('manifestCandidateCount')!=sum(1 for x in rows if x.get('manifestCandidate'))+len(m.get('inventoryDispositions',[])): errors.append('manifest candidate denominator mismatch')
 ids=[x.get('surfaceId') for x in rows]
 if len(ids)!=len(set(ids)): errors.append('duplicate surface ID')
 required={'surfaceId','repositoryId','surfaceKind','contractOwners','sourceAuthorityRefs','contractSchemaRefs','publicInterfaceRefs','requiredDependencyRefs','applicableContractDimensions','definitionFindings','staticValidationResult','sourceFingerprint','definitionDisposition','resolvedSourceRefs'}
 for row in rows:
  sid=row.get('surfaceId','unknown')
  if row.get('surfaceKind') not in {'PHYSICAL','LOGICAL','COMPOSITION','REPOSITORY'}: errors.append(f'{sid}: noncanonical surfaceKind')
  if row.get('definitionDisposition') not in {'complete','incomplete','needs-owner-facts','not-applicable'}: errors.append(f'{sid}: noncanonical definitionDisposition')
  policy=json.loads((root.parent/'ghatana-lifecycle/config/closure/contract-applicability.json').read_text())
  dimensions=row.get('applicableContractDimensions')
  if not isinstance(dimensions,list) or [x.get('dimension') for x in dimensions if isinstance(x,dict)]!=policy['dimensions']:
   errors.append(f'{sid}: noncanonical applicableContractDimensions')
  else:
   for dimension in dimensions:
    if set(dimension)!={'dimension','applicability','rationale','sourceRefs'} or dimension.get('applicability') not in {'required','conditional','not-applicable'} or not dimension.get('rationale') or not dimension.get('sourceRefs'):
     errors.append(f'{sid}: malformed applicability entry {dimension.get("dimension")}')
  if not row.get('applicabilityProfileIds') or any(x not in policy['profiles'] for x in row.get('applicabilityProfileIds',[])):
   errors.append(f'{sid}: unknown or missing applicability profile')
  if required-set(row): errors.append(f'{sid}: missing record fields')
  if not row.get('contractOwners') or any(not x.get('ownerId') or not x.get('authorityRef') for x in row.get('contractOwners',[])):
   errors.append(f'{sid}: missing contract owner')
  expected=actual_owner(row)
  if expected and expected not in [x.get('ownerId') for x in row.get('contractOwners',[])]: errors.append(f'{sid}: wrong owner')
  for ref in row.get('resolvedSourceRefs',[]):
   if not resolve_ref(ref['ref']).exists(): errors.append(f'{sid}: unresolved ref {ref["ref"]}')
  for item in row.get('sourceFingerprint',{}).get('files',[]):
   path=resolve_ref(item['path'])
   if source_digest(path) is None: errors.append(f'{sid}: fingerprint source missing {item["path"]}')
   elif source_digest(path)!=item['sha256']: errors.append(f'{sid}: stale source fingerprint {item["path"]}')
  for ref in uncovered_refs(row): errors.append(f'{sid}: source reference lacks per-file fingerprint {ref}')
  deps=row.get('requiredDependencyRefs',[])+row.get('conditionalDependencyRefs',[])
  seen={}
  for dep in deps:
   key=dep.get('serviceId') if isinstance(dep,dict) else None
   if not key or not dep.get('relationship') or not dep.get('contractRef') or dep.get('requiredness') not in ('required','conditional','declared; requiredness unspecified'):
    errors.append(f'{sid}: ambiguous dependency'); continue
   sig=(dep['contractRef'],dep['relationship'],dep['requiredness'])
   if key in seen and seen[key]!=sig: errors.append(f'{sid}: ambiguous dependency {key}')
   seen[key]=sig
   if not resolve_ref(dep['contractRef']).exists(): errors.append(f'{sid}: unresolved dependency contract {dep["contractRef"]}')
 inventory=m.get('inventoryDispositions',[]); inventory_ids=[x.get('candidateId') for x in inventory]
 if len(inventory_ids)!=len(set(inventory_ids)): errors.append('duplicate inventory disposition candidate')
 for item in inventory:
  cid=item.get('candidateId','unknown')
  if item.get('sourceDisposition') not in ('SUPPORT_ONLY','SUBSUMED') or item.get('inventoryClassification') not in ('support-only','subsumed'):
   errors.append(f'{cid}: invalid inventory disposition classification')
  for ref in item.get('resolvedSourceRefs',[]):
   if not resolve_ref(ref['ref']).exists(): errors.append(f'{cid}: unresolved inventory ref {ref["ref"]}')
  for src in item.get('sourceFingerprint',{}).get('files',[]):
   path=resolve_ref(src['path'])
   if source_digest(path) is None: errors.append(f'{cid}: inventory fingerprint source missing {src["path"]}')
   elif source_digest(path)!=src['sha256']: errors.append(f'{cid}: stale inventory source fingerprint {src["path"]}')
  for ref in uncovered_refs(item): errors.append(f'{cid}: source reference lacks per-file fingerprint {ref}')
 return errors

def semantic_coverage_errors(m):
 errors=[]
 if repo!='ghatana-media': return errors
 rows=m.get('surfaces',[]); by_id={x.get('surfaceId'):x for x in rows}
 if m.get('inventoryEntryCount')!=len(rows)+len(m.get('inventoryDispositions',[])):
  errors.append('inventory entry denominator mismatch')
 if m.get('manifestCandidateCount')!=29:
  errors.append('manifest candidate denominator mismatch')
 topo=json.loads((root/'.product-experience/surfaces/media-physical-topology.v1.json').read_text())
 dispositions={x.get('candidateId'):x for x in m.get('inventoryDispositions',[])}
 for candidate in topo.get('manifestCandidates',[]):
  sid=candidate.get('surfaceId'); row=by_id.get(sid); inventory=dispositions.get(sid)
  if candidate.get('disposition')=='PHYSICAL':
   if not row: errors.append(f'{sid}: active PHYSICAL candidate missing from surface records'); continue
   if row.get('surfaceKind')!='PHYSICAL': errors.append(f"{sid}: active candidate must use canonical PHYSICAL surface kind")
   if row.get('inventoryClassification')!='active-candidate': errors.append(f"{sid}: active candidate classification missing")
   if not row.get('publicInterfaceRefs'): errors.append(f"{sid}: PHYSICAL candidate has no source-backed public interface ref")
   if row.get('inventoryDisposition')!=candidate.get('disposition'): errors.append(f"{sid}: inventory disposition diverges from manifest")
   if inventory: errors.append(f'{sid}: active surface duplicated in inventory disposition records')
  else:
   if row: errors.append(f'{sid}: non-independent candidate must not be a structural surface row')
   if not inventory: errors.append(f'{sid}: non-independent candidate missing inventory disposition record')
   elif inventory.get('sourceDisposition')!=candidate.get('disposition') or inventory.get('inventoryClassification')!={'SUPPORT_ONLY':'support-only','SUBSUMED':'subsumed'}.get(candidate.get('disposition')):
    errors.append(f'{sid}: inventory classification diverges from source disposition')
   elif any(not item.get('exists') for item in inventory.get('resolvedSourceRefs',[])):
    errors.append(f'{sid}: inventory disposition source reference unresolved')
 if set(dispositions)!={x.get('surfaceId') for x in topo.get('manifestCandidates',[]) if x.get('disposition')!='PHYSICAL'}:
  errors.append('inventory disposition record set diverges from non-independent candidates')
 if m.get('inventoryDispositionCount')!=len(dispositions): errors.append('inventory disposition count mismatch')
 for comp in topo.get('compositions',[]):
  row=by_id.get(comp.get('surfaceId'))
  expected_kind='REPOSITORY' if comp.get('kind')=='REPOSITORY_ROOT' else 'COMPOSITION'
  if row and row.get('surfaceKind')!=expected_kind: errors.append(f"{row['surfaceId']}: noncanonical composition structural kind")
  if row and [x.get('surfaceId') for x in row.get('childContractRefs',[])]!=comp.get('children',[]):
   errors.append(f"{row['surfaceId']}: composition child contract crosswalk diverges")
 logical=by_id.get('media.product-definition',{})
 if logical.get('surfaceKind')!='LOGICAL': errors.append('media.product-definition: noncanonical logical structural kind')
 if logical.get('proposalScopeStatus')!='proposal-only; no semantic acceptance implied': errors.append('media.product-definition: proposal status boundary missing')
 if len(logical.get('publicHttpOperationInventory',[]))!=27: errors.append('media.product-definition: OpenAPI operation inventory count mismatch')
 if len(logical.get('publicGrpcRpcInventory',[]))!=43: errors.append('media.product-definition: protobuf RPC inventory count mismatch')
 if not logical.get('proposalOperationSourceRef') or logical.get('proposalOperationSourceRef') not in logical.get('publicInterfaceRefs',[]):
  errors.append('media.product-definition: proposal operation source not linked as public definition authority')
 http={(x.get('operationId'),x.get('method'),x.get('path')) for x in logical.get('publicHttpOperationInventory',[])}
 for record in logical.get('individualOperationContractRecords',[]):
  ref=record.get('sourceRef')
  if ref and not resolve_ref(ref).exists(): errors.append(f"{record.get('id')}: unresolved individual contract source ref {ref}")
  wire=record.get('wireBinding',{})
  if wire.get('operationId') and (wire.get('operationId'),wire.get('method'),wire.get('path')) not in http and not (not wire.get('path') and any(x[0]==wire.get('operationId') and x[1]==wire.get('method') for x in http)):
   errors.append(f"{record.get('id')}: wire binding does not match exact OpenAPI operation inventory")
 return errors

def closure_descriptor_errors(descriptor):
 errors=[]
 if descriptor.get('schemaVersion')!='closure-surface': errors.append('malformed Closure schema version')
 if set(descriptor)-ALLOWED_CLOSURE_FIELDS: errors.append('unknown Closure field')
 unknown=set(descriptor.get('extensions',{}))-({'ghatana.runtime'} if repo=='ghatana-runtime' else set())
 if unknown: errors.append('invalid extension namespace')
 return errors

def upload_size_type_errors(value_type='integer', maximum=1_099_511_627_776):
 return [] if value_type=='integer' and maximum==1_099_511_627_776 else ['incompatible exported type']
def incompatible_media_export():
 if repo!='ghatana-media': return []
 import yaml
 d=yaml.safe_load((root/'contracts/openapi/media.yaml').read_text())
 prop=d['components']['schemas']['UploadRequest']['properties']['expectedSizeBytes']
 return upload_size_type_errors(prop.get('type'),prop.get('maximum'))

def self_tests(m):
 out=[]
 def expect(name,mutate,needle,base=m,descriptor=None):
  clone=copy.deepcopy(base); desc=copy.deepcopy(descriptor)
  mutate(clone,desc)
  actual=errors_for(clone)
  if desc is not None: actual+=closure_descriptor_errors(desc)
  ok=any(needle in e for e in actual)
  out.append({'case':name,'result':'PASS' if ok else 'FAIL','observedFinding':next((e for e in actual if needle in e),None)})
 expect('malformed schema version',lambda x,d:x.update(schemaVersion='contract-definition-surface.v0'),'malformed schema version')
 expect('duplicate IDs',lambda x,d:x['surfaces'].append(copy.deepcopy(x['surfaces'][0])),'duplicate surface ID')
 expect('unknown Closure fields',lambda x,d:d.update(publicApi={}), 'unknown Closure field', descriptor=json.loads((root/'config/closure/surfaces/runtime.media-api.json' if repo=='ghatana-runtime' else root/'config/closure/media-product-definition/surface.json').read_text()))
 expect('unresolved references',lambda x,d:x['surfaces'][0]['resolvedSourceRefs'].append({'ref':'missing-contract.json','exists':False}),'unresolved ref')
 def wrong(x,d):
  row=x['surfaces'][0]; row['contractOwners'][-1]['ownerId']='wrong-owner'
 expect('wrong owner',wrong,'wrong owner')
 def ambiguous(x,d):
  row=next((r for r in x['surfaces'] if r.get('conditionalDependencyRefs')),x['surfaces'][0])
  if row.get('conditionalDependencyRefs'):
   dep=row['conditionalDependencyRefs'][0]; row['conditionalDependencyRefs'].append({**dep,'contractRef':'missing-conflicting-contract.yaml'})
  else:
   row.setdefault('conditionalDependencyRefs',[]).append({'serviceId':'x','relationship':'a','contractRef':'one.yaml','requiredness':'conditional'})
   row['conditionalDependencyRefs'].append({'serviceId':'x','relationship':'b','contractRef':'two.yaml','requiredness':'conditional'})
 expect('ambiguous dependency',ambiguous,'ambiguous dependency')
 expect('invalid extension namespace',lambda x,d:d.setdefault('extensions',{}).update({'unregistered.namespace':{}}),'invalid extension namespace',descriptor=json.loads((root/'config/closure/surfaces/runtime.media-api.json' if repo=='ghatana-runtime' else root/'config/closure/media-product-definition/surface.json').read_text()))
 def stale(x,d): x['surfaces'][0]['sourceFingerprint']['files'][0]['sha256']='0'*64
 expect('stale generated/source fingerprint',stale,'stale source fingerprint')
 def remove_source_pin(x,d):
  row=x['surfaces'][0]; target=resolve_ref(row['publicInterfaceRefs'][0]).resolve()
  row['sourceFingerprint']['files']=[pin for pin in row['sourceFingerprint']['files'] if resolve_ref(pin['path']).resolve()!=target]
 expect('declared source ref must have a file fingerprint',remove_source_pin,'source reference lacks per-file fingerprint')
 if repo=='ghatana-media':
  broken=copy.deepcopy(m)
  physical=next(x for x in broken['surfaces'] if x.get('inventoryDisposition')=='PHYSICAL')
  physical['publicInterfaceRefs']=[]
  actual=semantic_coverage_errors(broken)
  out.append({'case':'physical surface missing public interface','result':'PASS' if any('no source-backed public interface' in x for x in actual) else 'FAIL','observedFinding':next((x for x in actual if 'no source-backed public interface' in x),None)})
  broken=copy.deepcopy(m); physical=next(x for x in broken['surfaces'] if x['surfaceKind']=='PHYSICAL'); physical['applicableContractDimensions'][0]['dimension']='wrong-dimension'
  actual=errors_for(broken)
  out.append({'case':'noncanonical dimension identity rejected','result':'PASS' if any('noncanonical applicableContractDimensions' in x for x in actual) else 'FAIL','observedFinding':next((x for x in actual if 'noncanonical applicableContractDimensions' in x),None)})
  broken=copy.deepcopy(m); logical=next(x for x in broken['surfaces'] if x['surfaceId']=='media.product-definition'); logical['publicGrpcRpcInventory']=[]
  actual=semantic_coverage_errors(broken)
  out.append({'case':'proposal interface inventory drift','result':'PASS' if any('protobuf RPC inventory count mismatch' in x for x in actual) else 'FAIL','observedFinding':next((x for x in actual if 'protobuf RPC inventory count mismatch' in x),None)})
  broken=copy.deepcopy(m); physical=next(x for x in broken['surfaces'] if x.get('surfaceKind')=='PHYSICAL'); physical['surfaceKind']='support'
  actual=errors_for(broken)
  out.append({'case':'noncanonical structural kind rejected','result':'PASS' if any('noncanonical surfaceKind' in x for x in actual) else 'FAIL','observedFinding':next((x for x in actual if 'noncanonical surfaceKind' in x),None)})
  broken=copy.deepcopy(m); logical=next(x for x in broken['surfaces'] if x['surfaceId']=='media.product-definition'); record=next(x for x in logical['individualOperationContractRecords'] if x.get('wireBinding',{}).get('operationId')); record['wireBinding']['operationId']='inventedOperation'
  actual=semantic_coverage_errors(broken)
  out.append({'case':'individual operation wire binding drift','result':'PASS' if any('wire binding does not match exact OpenAPI' in x for x in actual) else 'FAIL','observedFinding':next((x for x in actual if 'wire binding does not match exact OpenAPI' in x),None)})
  actual=upload_size_type_errors('string',1_099_511_627_776)
  out.append({'case':'incompatible exported type','result':'PASS' if 'incompatible exported type' in actual else 'FAIL','observedFinding':actual[0] if actual else None})
 return out

def main():
 m=json.loads(matrix_path.read_text()); errors=errors_for(m)
 descriptors=sorted((root/'config/closure/surfaces').glob('*.json')) if repo=='ghatana-runtime' else [root/'config/closure/media-product-definition/surface.json']
 closure_errors=[]
 for p in descriptors: closure_errors += [f'{p.relative_to(root)}: {e}' for e in closure_descriptor_errors(json.loads(p.read_text()))]
 errors+=closure_errors+incompatible_media_export()
 cases=self_tests(m)
 out={'repositoryId':repo,'sourceCommit':m.get('sourceCommit'),'surfaceCount':m.get('surfaceCount'),'matrixValidation':{'status':'PASS' if not errors else 'FAIL','errors':errors},'negativeCases':cases}
 out['negativeCasesStatus']='PASS' if all(x['result']=='PASS' for x in cases) else 'FAIL'
 (root/'.ghatana/definition/static-validation.json').write_text(json.dumps({'schemaVersion':'contract-definition-static-validation.v1','repositoryId':repo,'sourceCommit':m.get('sourceCommit'),'scope':'Definition projection shape, source refs/fingerprints, owner mapping, dependencies and bounded API type compatibility. No runtime or lifecycle execution.','checks':[{'id':'surface-matrix','status':out['matrixValidation']['status'],'surfaceCount':m.get('surfaceCount'),'errors':errors},{'id':'static-negative-cases','status':out['negativeCasesStatus'],'cases':cases}]},indent=2)+'\n')
 print(json.dumps(out,indent=2))
 return 0 if out['matrixValidation']['status']=='PASS' and out['negativeCasesStatus']=='PASS' else 1
if __name__=='__main__': raise SystemExit(main())
