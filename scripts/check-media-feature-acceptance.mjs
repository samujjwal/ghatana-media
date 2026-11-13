#!/usr/bin/env node
/** Developer-only static acceptance check; never invokes gtool or executes Media providers. */
import {readFileSync, existsSync, readdirSync} from "node:fs";
import {resolve, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const json=p=>JSON.parse(readFileSync(join(root,p),"utf8"));
const exists=p=>existsSync(join(root,p));
const docFor=id=>id.startsWith("media.physical.")
  ?"docs/surfaces/"+id.slice("media.physical.".length)+"/README.md":
  id.startsWith("media.composition.")
  ?"docs/surfaces/composition-"+id.slice("media.composition.".length).replaceAll(".","-")+"/README.md":
  id.startsWith("media.surface.")
  ?"docs/surfaces/surface-"+id.slice("media.surface.".length).replaceAll(".","-")+"/README.md":null;
export function validateAcceptance(config,roster,delivery,capabilities,overlay=null) {
 const issues=[],check=(ok,message)=>{if(!ok)issues.push(message)};
 const ids=new Set(roster.map(r=>r.id));
 check(roster.length===56&&config.surfaces.length===56&&new Set(config.surfaces.map(r=>r.id)).size===56,
  "canonical surface count/identity drift");
 const map=new Map(config.surfaces.map(r=>[r.id,r]));
 for(const r of roster){
  const s=map.get(r.id);
  check(Boolean(s),"missing canonical surface "+r.id);
  if(!s)continue;
  check(r.type===s.type&&r.sourcePath===s.sourcePath&&r.topologyDisposition===s.topologyDisposition,
   "owner/topology drift "+r.id);
  check(s.descriptionSource===docFor(s.id)&&exists(s.descriptionSource),"missing source README "+r.id);
  if(r.sourcePath)check(exists(r.sourcePath),"missing owning source "+r.id);
  check(s.applicablePdpSourceRoots.length===4&&s.applicablePdpSourceRoots.every(exists),
   "missing PDP source roots "+r.id);
  check(s.featureOutcome?.length>12&&s.implementationToFinish?.length>12&&s.acceptanceOracle?.length>12,
   "missing falsifiable feature output/oracle "+r.id);
  check(s.developmentFeatureComplete==="NOT_ASSESSED"&&s.gtoolPreparation==="CANONICAL_SOURCE_METADATA_ONLY_NOT_PHASE_PROOF",
   "unsupported feature/phase qualification claim "+r.id);
  const route=delivery.surfaces.find(x=>x.id===r.id);
  check(Boolean(route)&&JSON.stringify(route.openTaskIds)===JSON.stringify(s.relatedOpenTaskIds),
   "changed task routing "+r.id);
 }
 const actualDocs=readdirSync(join(root,"docs/surfaces")).filter(n=>exists("docs/surfaces/"+n+"/README.md"))
  .map(n=>"docs/surfaces/"+n+"/README.md").sort();
 const definedDocs=[...config.surfaces.map(x=>x.descriptionSource),...config.auxiliarySurfaceDocs].sort();
 check(JSON.stringify(actualDocs)===JSON.stringify(definedDocs),"surface README inventory changed");
 check(config.components.length===11&&new Set(config.components.map(x=>x.path)).size===11,
  "support module inventory changed");
 for(const c of config.components){
  check(ids.has(c.parentSurfaceId),"non-canonical support parent "+c.path);
  check(exists(c.path)&&exists(c.doc),"missing support code or docs "+c.path);
  check(c.kind==="SUPPORT_IMPLEMENTATION_UNIT_NOT_CANONICAL_SURFACE"&&c.independentGtoolPhase==="NOT_CREATED",
   "support unit improperly promoted to phase "+c.path);
 }
 check(capabilities.records.length===config.census.pdp0CapabilityLeaves,"PDP0 capability denominator drift");
 check(delivery.journeys.length===config.census.productJourneys,"journey denominator drift");
 if(overlay){
  check(overlay.surfaces.length===config.surfaces.length&&overlay.areas.length===delivery.areas.length&&
    overlay.journeys.length===delivery.journeys.length,"feature execution overlay census drift");
  for(const row of overlay.surfaces){
    const detailed=config.surfaces.find(s=>s.id===row.id);
    check(Boolean(detailed)&&row.permanentDoc===detailed?.descriptionSource&&
      JSON.stringify(row.openTaskIds)===JSON.stringify(detailed?.relatedOpenTaskIds),
      "feature overlay/detail source drift "+row.id);
  }
  check(overlay.additionalImplementationModules.length===config.components.length,
    "feature overlay support-component census drift");
 }
 const routes=json("config/route-manifest.json");
 const openapi=readFileSync(join(root,"contracts/openapi/media.yaml"),"utf8");
 const openapiOps=[...openapi.matchAll(/^      operationId: /gm)].length;
 check(routes.routes.length===config.census.actualHttpRoutes&&openapiOps===config.census.actualHttpRoutes,
  "HTTP route source population drift");
 const protos=["modules/speech/stt-service/src/main/proto/stt_service.proto",
   "modules/speech/tts-service/src/main/proto/tts_service.proto",
   "modules/vision/vision-service/src/main/proto/vision_service.proto",
   "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto"];
 const rpcCount=protos.reduce((n,p)=>n+[...readFileSync(join(root,p),"utf8").matchAll(/^\s*rpc\s+\w+\s*\(/gm)].length,0);
 check(rpcCount===config.census.actualGrpcRpcs,"gRPC protocol source population drift");
 const source=readFileSync(join(root,".product-experience/surface-registry.yaml"),"utf8");
 check(Number(source.match(/^  httpOperations: (\d+)$/m)?.[1])===config.census.namedPdp1Http&&
   Number(source.match(/^  grpcRpcs: (\d+)$/m)?.[1])===config.census.namedPdp1Grpc,
  "PDP1 named operation count drift; preserve named versus actual distinction");
 return issues;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const errors=validateAcceptance(json("config/development/media-feature-surface-acceptance.v1.json"),
  json("docs/implementation/MEDIA-SURFACE-ROSTER-RECONCILIATION.v1.json").roster,
  json("docs/development/surface-delivery.json"),
  json("docs/development/capability-implementation-crosswalk.v1.json"),
  json("docs/development/feature-complete-map.json"));
 if(errors.length){console.error(errors.join("\n"));process.exitCode=1}
 else console.log("MEDIA_FEATURE_ACCEPTANCE_OK canonical=56 support=11 journeys=30 capabilities=469 HTTP=30 gRPC=45");
}
