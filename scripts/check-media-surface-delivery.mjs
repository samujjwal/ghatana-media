#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const json=p=>JSON.parse(readFileSync(resolve(root,p),"utf8"));
export function validateSurfaceDelivery(plan, register, crosswalk) {
 const errors=[],all=new Map(register.tasks.map(t=>[t.id,t]));
 const open=new Set(register.tasks.filter(t=>t.state==="OPEN").map(t=>t.id));
 const ids=new Map();
 for(const area of plan.areas) for(const id of area.taskIds) {
   if(ids.has(id))errors.push("duplicate primary task "+id);
   ids.set(id,area.id);
   if(!all.has(id))errors.push("unknown task "+id);
 }
 for(const id of open)if(!ids.has(id))errors.push("unmapped open task "+id);
 for(const [id] of ids)if(all.get(id)?.state==="OPTIONAL_DEFERRED_NO_CORE_BLOCKER")
   errors.push("optional task on core delivery lane "+id);
 const expected=new Set(register.journeys.map(j=>j.id));
 const got=new Set(plan.journeys.map(j=>j.id));
 if(expected.size!==got.size||[...expected].some(id=>!got.has(id)))
   errors.push("journey coverage mismatch");
 for(const j of plan.journeys)if(ids.get(j.taskId)!==j.primaryArea)errors.push("journey area mismatch "+j.id);
 const surfaceIds=new Set(register.surfaces.map(s=>s.id));
 const planSurfaceIds=new Set(plan.surfaces.map(s=>s.id));
 if(surfaceIds.size!==planSurfaceIds.size||[...surfaceIds].some(s=>!planSurfaceIds.has(s)))
   errors.push("surface coverage mismatch");
 for(const s of plan.surfaces)for(const id of s.openTaskIds)
   if(!all.has(id)||!ids.has(id))errors.push("bad surface task "+s.id+" "+id);
 const familyCounts=new Map();
 for(const leaf of crosswalk.records)familyCounts.set(leaf.familyId,(familyCounts.get(leaf.familyId)||0)+1);
 if(crosswalk.records.length!==469)errors.push("PDP0 capability denominator drift");
 for(const family of plan.capabilityFamilies)
   if(familyCounts.get(family.familyId)!==family.leafCount)
     errors.push("capability family count drift "+family.familyId);
 if(familyCounts.size!==plan.capabilityFamilies.length)errors.push("capability families omitted");
 if(plan.counts.open!==open.size)errors.push("source-open count changed; refresh plan routing");
 return errors;
}
const plan=json("docs/development/surface-delivery.json"),
 register=json("docs/development/remaining-work.json"),
 cap=json("docs/development/capability-implementation-crosswalk.v1.json");
const problems=validateSurfaceDelivery(plan,register,cap);
if(problems.length) {
 console.error(problems.join("\n"));
 process.exitCode=1;
} else if(process.argv.includes("--list")) {
 for(const area of plan.areas) console.log(area.id+"\t"+area.taskIds.length+"\t"+area.title);
} else if(process.argv.includes("--check")||process.argv.length<=2) {
 console.log("SURFACE_DELIVERY_OK areas="+plan.areas.length+" tasks="+plan.counts.open+" surfaces="+plan.surfaces.length+" journeys="+plan.journeys.length+" capabilityLeaves="+cap.records.length);
}
