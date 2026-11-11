#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
 for(const [id] of ids)if(all.has(id)&&all.get(id).state!=="OPEN")
   errors.push("non-open task assigned to core delivery lane "+id);
 const expected=new Set(register.journeys.map(j=>j.id));
 const got=new Set(plan.journeys.map(j=>j.id));
 if(expected.size!==got.size||[...expected].some(id=>!got.has(id)))
   errors.push("journey coverage mismatch");
 for(const j of plan.journeys)if(ids.get(j.taskId)!==j.primaryArea)errors.push("journey area mismatch "+j.id);
 const surfaceIds=new Set(register.surfaces.map(s=>s.id));
 const planSurfaceIds=new Set(plan.surfaces.map(s=>s.id));
 if(planSurfaceIds.size!==plan.surfaces.length)errors.push("duplicate surface ID");
 if(surfaceIds.size!==planSurfaceIds.size||[...surfaceIds].some(s=>!planSurfaceIds.has(s)))
   errors.push("surface coverage mismatch");
 for(const s of plan.surfaces)for(const id of s.openTaskIds)
   if(!all.has(id)||!ids.has(id))errors.push("bad surface task "+s.id+" "+id);
 const familyCounts=new Map();
 for(const leaf of crosswalk.records)familyCounts.set(leaf.familyId,(familyCounts.get(leaf.familyId)||0)+1);
 if(crosswalk.records.length!==469)errors.push("PDP0 capability denominator drift");
 const planFamilyIds=new Set(plan.capabilityFamilies.map(family=>family.familyId));
 if(planFamilyIds.size!==plan.capabilityFamilies.length)errors.push("duplicate capability family ID");
 for(const family of plan.capabilityFamilies)
   if(familyCounts.get(family.familyId)!==family.leafCount)
     errors.push("capability family count drift "+family.familyId);
 if(familyCounts.size!==planFamilyIds.size||[...familyCounts.keys()].some(id=>!planFamilyIds.has(id)))
   errors.push("capability families coverage mismatch");
 if(plan.counts.open!==open.size)errors.push("source-open count changed; refresh plan routing");
 return errors;
}

/**
 * A change-impact SELECTOR, not a test executor or a verdict. It reports only
 * relevant area checks. Reuse a prior passing result only after separately
 * comparing all transitive inputs and host/provider/toolchain fingerprints.
 */
export function selectAffectedAreas(plan, changedPaths) {
 const paths=[...new Set(changedPaths.map(p=>p.replaceAll("\\","/")))];
 const semantic=paths.some(p=>p.startsWith(".product-experience/"));
 const shared=paths.some(p=>p.startsWith("runtime-contracts/")
   || p.startsWith("libs/audio-video-types/")
   || p.startsWith("contracts/openapi/")
   || p==="config/route-manifest.json"
   || p==="settings.gradle.kts"
   || p==="package.json"
   || p==="pnpm-lock.yaml"
   || p.startsWith("gradle/"));
 return plan.areas.filter(area=>{
   if(area.id!=="history-retention"&&(semantic||shared))return true;
   return paths.some(p=>area.source.some(owner=>
     p===owner || p.startsWith(owner.endsWith("/")?owner:owner+"/")));
 });
}
function changedSince(ref) {
 if(!/^[A-Za-z0-9._/~-]+$/.test(ref)||ref.startsWith("-"))throw new Error("invalid Git ref");
 const commands=[
   ["diff","--name-only",ref+"...HEAD"],
   ["diff","--name-only","HEAD"],
   ["ls-files","--others","--exclude-standard"]
 ];
 const result=new Set();
 for(const args of commands) {
   const run=spawnSync("git",args,{cwd:root,encoding:"utf8",maxBuffer:2*1024*1024});
   if(run.status!==0)throw new Error("git changed-input query failed for "+args[0]+": "+(run.stderr||"nonzero exit").trim());
   for(const p of run.stdout.split("\n").filter(Boolean))result.add(p);
 }
 return [...result].sort();
}
function runCli(args=process.argv.slice(2)) {
 const plan=json("docs/development/surface-delivery.json"),
       register=json("docs/development/remaining-work.json"),
       cap=json("docs/development/capability-implementation-crosswalk.v1.json");
 const problems=validateSurfaceDelivery(plan,register,cap);
 if(problems.length)throw new Error(problems.join("\n"));
 const affects=args.filter(a=>a.startsWith("--affected="));
 if(affects.length>1)throw new Error("only one --affected Git ref allowed");
 if(affects.length) {
   const changedPaths=changedSince(affects[0].slice("--affected=".length));
   const areas=selectAffectedAreas(plan,changedPaths);
   console.log(JSON.stringify({changedPaths,areas:areas.map(a=>({
     id:a.id,taskIds:a.taskIds,focusedChecks:a.checks
   })),note:"Selection only; external host/current rights/provider changes require explicit targeted recheck. No tests were run."},null,2));
 } else if(args.includes("--list")) {
   for(const area of plan.areas)console.log(area.id+"\t"+area.taskIds.length+"\t"+area.title);
 } else {
   console.log("SURFACE_DELIVERY_OK areas="+plan.areas.length+" tasks="+plan.counts.open+
     " surfaces="+plan.surfaces.length+" journeys="+plan.journeys.length+
     " capabilityLeaves="+cap.records.length);
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {runCli()}catch(error){console.error(error.message);process.exitCode=1}
}
