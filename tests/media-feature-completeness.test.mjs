import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {validateFeatureMap} from "../scripts/check-media-feature-completeness.mjs";
const base=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>JSON.parse(readFileSync(resolve(base,p),"utf8"));
const args=[
  read("docs/development/feature-complete-map.json"),
  read("docs/development/remaining-work.json"),
  read("docs/development/surface-delivery.json"),
  read("docs/development/capability-implementation-crosswalk.v1.json")
];
test("every active surface and real outcome is source-bound once",()=>{
 assert.deepEqual(validateFeatureMap(...args),[]);
});
test("reject duplicate surface identity, missing journey and old task recycling",()=>{
 let p=structuredClone(args[0]);
 p.surfaces.push(p.surfaces[0]);
 assert.ok(validateFeatureMap(p,...args.slice(1)).some(s=>s.includes("duplicate surface")));
 p=structuredClone(args[0]);p.journeys.pop();
 assert.ok(validateFeatureMap(p,...args.slice(1)).some(s=>s.includes("missing journey")));
 p=structuredClone(args[0]);p.areas[0].taskIds.push(p.areas[0].taskIds[0]);
 assert.ok(validateFeatureMap(p,...args.slice(1)).some(s=>s.includes("not assigned exactly once")));
});
