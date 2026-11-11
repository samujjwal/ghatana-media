import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateSurfaceDelivery, selectAffectedAreas } from "../scripts/check-media-surface-delivery.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>JSON.parse(readFileSync(resolve(root,p),"utf8"));
const plan=read("docs/development/surface-delivery.json");
const register=read("docs/development/remaining-work.json");
const capabilities=read("docs/development/capability-implementation-crosswalk.v1.json");
test("every current open task, surface, journey and capability family routes once",()=>{
 assert.deepEqual(validateSurfaceDelivery(plan,register,capabilities),[]);
 assert.equal(plan.counts.open,72);
 assert.equal(plan.areas.length,9);
 assert.equal(plan.counts.verified,30);
 assert.equal(plan.counts.optional,1);
 for(const area of plan.areas)assert.equal(Object.hasOwn(area,"tasks"),false,"task definitions must not be duplicated");
 assert.equal(Object.hasOwn(plan,"taskAssignments"),false);
});
test("duplicate, missing, and deferred core tasks are rejected",()=>{
 let copy=structuredClone(plan);
 copy.areas[0].taskIds.push(copy.areas[0].taskIds[0]);
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("duplicate")));
 copy=structuredClone(plan);
 copy.areas[0].taskIds.shift();
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("unmapped open")));
 copy=structuredClone(plan);
 copy.areas[0].taskIds.push(register.tasks.find(t=>t.state==="OPTIONAL_DEFERRED_NO_CORE_BLOCKER").id);
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("optional task")));
});

test("non-open authoritative tasks cannot be assigned to a delivery area",()=>{
 const copy=structuredClone(plan);
 copy.areas[0].taskIds.push(register.tasks.find(t=>t.state==="VERIFIED").id);
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("non-open task")));
});

test("duplicate surface IDs cannot mask an omitted surface",()=>{
 const copy=structuredClone(plan);
 copy.surfaces[1].id=copy.surfaces[0].id;
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("duplicate surface ID")));
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("surface coverage mismatch")));
});

test("duplicate capability family IDs cannot mask an omitted family",()=>{
 const copy=structuredClone(plan);
 copy.capabilityFamilies[1].familyId=copy.capabilityFamilies[0].familyId;
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("duplicate capability family ID")));
 assert.ok(validateSurfaceDelivery(copy,register,capabilities).some(x=>x.includes("capability families coverage mismatch")));
});

test("change selector avoids repeated unrelated test suites",()=>{
 const ids=paths=>selectAffectedAreas(plan,paths).map(a=>a.id);
 assert.deepEqual(ids(["modules/production/animation/src/main/java/AnimationRenderer.java"]),["creative-preview"]);
 assert.deepEqual(ids(["libs/audio-video-client/src/cli.ts"]),["headless-media"]);
 assert.deepEqual(ids(["libs/audio-video-client/src/operations.ts"]),["headless-media","delivery-agents"]);
 assert.deepEqual(ids(["docs/development/USABLE-SURFACE-DELIVERY.md"]),[]);
 assert.equal(ids(["runtime-contracts/src/main/java/Updated.java"]).length,8);
 assert.deepEqual(ids(["docs/implementation/old-run.md"]),["history-retention"]);
});
