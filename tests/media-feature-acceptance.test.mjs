import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateAcceptance} from "../scripts/check-media-feature-acceptance.mjs";
const parse=p=>JSON.parse(readFileSync(p,"utf8"));
const manifest=parse("config/development/media-feature-surface-acceptance.v1.json");
const roster=parse("docs/implementation/MEDIA-SURFACE-ROSTER-RECONCILIATION.v1.json").roster;
const delivery=parse("docs/development/surface-delivery.json");
const capabilities=parse("docs/development/capability-implementation-crosswalk.v1.json");
test("56 canonical surfaces and 11 support components have stable feature acceptance",()=>{
 assert.deepEqual(validateAcceptance(manifest,roster,delivery,capabilities),[]);
 assert.equal(manifest.surfaces.length,56);
 assert.equal(manifest.components.length,11);
 assert.equal(manifest.auxiliarySurfaceDocs.length,3);
});
test("source drift and false phase completion are rejected",()=>{
 const absent=structuredClone(manifest);
 absent.surfaces.pop();
 assert.ok(validateAcceptance(absent,roster,delivery,capabilities).some(x=>x.includes("count")));
 const fake=structuredClone(manifest);
 fake.components[0].independentGtoolPhase="DEV_COMPLETE";
 assert.ok(validateAcceptance(fake,roster,delivery,capabilities).some(x=>x.includes("improperly promoted")));
});
test("changed leaf or task routing requires a source refresh",()=>{
 const removed=structuredClone(capabilities);
 removed.records.pop();
 assert.ok(validateAcceptance(manifest,roster,delivery,removed).some(x=>x.includes("PDP0 capability")));
 const changed=structuredClone(delivery);
 changed.surfaces[0].openTaskIds.push("media.dev.invented");
 assert.ok(validateAcceptance(manifest,roster,changed,capabilities).some(x=>x.includes("changed task")));
});
