import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateSurfaceDelivery } from "../scripts/check-media-surface-delivery.mjs";

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
