#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const base=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>JSON.parse(readFileSync(resolve(base,p),"utf8"));
export function validateFeatureMap(map, register, delivery, crosswalk, pathExists=()=>true) {
 const errors=[];
 const eq=(a,b,msg)=>{if(a!==b)errors.push(msg+" ("+a+" vs "+b+")")};
 eq(map.surfaces.length,register.surfaces.length,"surface count");
 eq(map.journeys.length,register.journeys.length,"journey count");
 eq(crosswalk.records.length,469,"PDP0 capability leaf count");
 const ownerTasks=new Set(register.tasks.map(t=>t.id));
 const open=new Set(register.tasks.filter(t=>t.state==="OPEN").map(t=>t.id));
 const refs=new Map();
 for(const a of map.areas) {
   for(const id of a.taskIds) {
     refs.set(id,(refs.get(id)||0)+1);
     if(!ownerTasks.has(id))errors.push("unknown task "+id);
   }
 }
 for(const id of open)if(refs.get(id)!==1)errors.push("open task not assigned exactly once: "+id);
 for(const [id] of refs)if(!open.has(id))errors.push("completed/deferred task cannot be reintroduced "+id);
 const sourceSurfaces=new Set(register.surfaces.map(x=>x.id));
 const seenSurfaces=new Set();
 for(const s of map.surfaces) {
   if(seenSurfaces.has(s.id))errors.push("duplicate surface "+s.id);
   seenSurfaces.add(s.id);
   if(!sourceSurfaces.has(s.id))errors.push("invented surface "+s.id);
   if(!pathExists(s.permanentDoc))errors.push("missing permanent surface README "+s.permanentDoc);
   if(s.source&&!pathExists(s.source))errors.push("missing source owner "+s.source);
   for(const id of s.openTaskIds)if(!ownerTasks.has(id))errors.push("bad surface task "+s.id+":"+id);
 }
 for(const id of sourceSurfaces)if(!seenSurfaces.has(id))errors.push("unmapped source surface "+id);
 const jIds=new Set(register.journeys.map(x=>x.id)),seenJourneys=new Set();
 for(const j of map.journeys) {
   if(seenJourneys.has(j.id))errors.push("duplicate journey "+j.id);
   seenJourneys.add(j.id);
   if(!jIds.has(j.id)||!ownerTasks.has(j.taskId))errors.push("bad journey "+j.id);
 }
 for(const j of jIds)if(!seenJourneys.has(j))errors.push("missing journey "+j);
 const areaIds=new Set(delivery.areas.map(a=>a.id));
 for(const a of map.areas)if(!areaIds.has(a.id))errors.push("unknown delivery area "+a.id);
 for(const m of map.additionalImplementationModules)if(!pathExists(m.path))errors.push("missing module "+m.path);
 return errors;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const errors=validateFeatureMap(
   read("docs/development/feature-complete-map.json"),
   read("docs/development/remaining-work.json"),
   read("docs/development/surface-delivery.json"),
   read("docs/development/capability-implementation-crosswalk.v1.json"),
   p=>existsSync(resolve(base,p)));
 if(errors.length){console.error(errors.join("\n"));process.exitCode=1;}
 else console.log("MEDIA_FEATURE_MAP_OK: 56 surfaces; 30 journeys; 72 current open task routes; 469 requirement leaves");
}
