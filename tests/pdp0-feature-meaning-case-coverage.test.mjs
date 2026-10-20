import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parseYaml = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const requirements = parseYaml(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/requirements.yaml"), "utf8"));
const capabilities = parseYaml(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
const capabilityLeafReview = parseYaml(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"), "utf8"));
const campaignExtensions = parseYaml(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/campaign-extensions.yaml"), "utf8"));

const caseById = new Map(requirements.requirements.flatMap((row) => row.acceptanceCases ?? []).map((row) => [row.id, row]));
const familyByCaseId = new Map(requirements.requirements.flatMap((row) => (row.acceptanceCases ?? []).map((acceptanceCase) => [acceptanceCase.id, row])));
const caseText = (id) => {
  const row = caseById.get(id);
  assert.ok(row, `PDP-0 acceptance case exists: ${id}`);
  for (const field of ["given", "when", "then", "rejection"]) {
    assert.equal(typeof row[field], "string", `${id}.${field} is a string`);
    assert.ok(row[field].trim().length > 0, `${id}.${field} is nonempty`);
  }
  assert.match(row.given, /authori[sz]ed/u, `${id} names an authorized actor or caller`);
  return [row.given, row.when, row.then, row.rejection].join(" ").toLocaleLowerCase("en-US");
};

const assertTerms = (id, patterns) => {
  const text = caseText(id);
  for (const [description, pattern] of patterns) {
    assert.match(text, pattern, `${id} defines ${description}`);
  }
};

test("PDP-0 feature acceptance cases have complete, feature-specific meaning", () => {
  const expectedCases = [
    "MEDIA-REQ-CAP-PROJECT-AC-05", "MEDIA-REQ-CAP-PROJECT-AC-06",
    "MEDIA-REQ-CAP-PROJECT-AC-07", "MEDIA-REQ-CAP-PROJECT-AC-08",
    "MEDIA-REQ-CAP-ARTIFACT-AC-06", "MEDIA-REQ-CAP-ARTIFACT-AC-07",
    "MEDIA-REQ-CAP-ARTIFACT-AC-08", "MEDIA-REQ-CAP-ARTIFACT-AC-09",
    "MEDIA-REQ-CAP-ARTIFACT-AC-10", "MEDIA-REQ-CAP-ARTIFACT-AC-11",
    "MEDIA-REQ-CAP-DELIVER-AC-04", "MEDIA-REQ-CAP-DELIVER-AC-05",
    "MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-08", "MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION-AC-07",
    "MEDIA-REQ-CAP-MASTER-AUDIO-AC-04", "MEDIA-REQ-CAP-MASTER-AUDIO-AC-05",
    "MEDIA-REQ-CAP-COMPOSE-AC-04", "MEDIA-REQ-CAP-COMPOSE-AC-05",
    "MEDIA-REQ-CAP-COMPOSE-AC-06", "MEDIA-REQ-CAP-COMPOSE-AC-07",
    "MEDIA-REQ-CAP-COMPOSE-AC-08", "MEDIA-REQ-CAP-COMPOSE-AC-09", "MEDIA-REQ-CAP-COMPOSE-AC-10",
    "MEDIA-REQ-CAP-STREAM-AC-04", "MEDIA-REQ-CAP-STREAM-AC-05", "MEDIA-REQ-CAP-STREAM-AC-06",
    "MEDIA-REQ-CAP-STREAM-AC-07", "MEDIA-REQ-CAP-AUDIO-ANALYSIS-AC-03",
    "MEDIA-REQ-CAP-QUALITY-AC-10", "MEDIA-REQ-CAP-QUALITY-AC-11",
    "MEDIA-REQ-CAP-QUALITY-AC-12", "MEDIA-REQ-CAP-QUALITY-AC-13",
    "MEDIA-REQ-CAP-MULTIMODAL-AC-03", "MEDIA-REQ-CAP-ANIMATION-AC-04",
    "MEDIA-REQ-CAP-ANIMATION-OUTPUT-AC-03", "MEDIA-REQ-CAP-SIMULATION-AC-04",
    "MEDIA-REQ-CAP-SIMULATION-AC-05",
    "MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-07", "MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-08",
    "MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-09", "MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-10",
    "MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-11", "MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-12",
    "MEDIA-REQ-CAP-RIGHTS-AC-06", "MEDIA-REQ-CAP-RIGHTS-AC-07", "MEDIA-REQ-CAP-RIGHTS-AC-08",
    "MEDIA-REQ-CAP-RIGHTS-AC-09", "MEDIA-REQ-CAP-RIGHTS-AC-10", "MEDIA-REQ-CAP-RIGHTS-AC-11",
    "MEDIA-REQ-CAP-RIGHTS-AC-12", "MEDIA-REQ-CAP-RIGHTS-AC-13",
    "MEDIA-REQ-CAP-PROVENANCE-AC-04", "MEDIA-REQ-CAP-PROVENANCE-AC-05", "MEDIA-REQ-CAP-PROVENANCE-AC-06",
    "MEDIA-REQ-CAP-COMPOSE-AC-11", "MEDIA-REQ-CAP-QUALITY-AC-14",
    "MEDIA-REQ-CAP-GENERATE-VIDEO-AC-04", "MEDIA-REQ-CAP-GENERATE-VIDEO-AC-05", "MEDIA-REQ-CAP-GENERATE-VIDEO-AC-06",
    "MEDIA-REQ-CAP-JOB-AC-04", "MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-09",
  ];
  assert.equal(expectedCases.length, 61, "all independently identified PDP-0 semantic gaps have exact feature acceptance cases");
  assert.equal(expectedCases.length, new Set(expectedCases).size, "expected case IDs are unique");
  for (const id of expectedCases) caseText(id);
  for (const id of expectedCases) {
    const family = familyByCaseId.get(id);
    assert.ok(family, `${id} belongs to one canonical PDP-0 requirement family`);
    assert.ok(Array.isArray(family.capabilityIds) && family.capabilityIds.length > 0, `${family.id} links to canonical capability leaves`);
    assert.ok(family.phase === "PDP-0" || family.phase === undefined, `${family.id} remains PDP-0-owned`);
  }

  assertTerms("MEDIA-REQ-CAP-PROJECT-AC-05", [
    ["project or library scope", /project|library/u],
    ["hierarchy or nesting", /hierarch|nest|folder|bin/u],
    ["non-mutating source behavior", /without (?:mutating|changing)|does not (?:mutate|change)|makes no project or asset mutation until explicitly confirmed|source.{0,30}(?:immutable|unchanged)/u],
    ["exact artifact version", /exact.{0,30}version|version.{0,30}exact/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-PROJECT-AC-06", [
    ["smart-bin semantics", /smart bin/u],
    ["observed classification", /observed/u], ["inferred classification", /inferred/u], ["unknown classification", /unknown/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-ARTIFACT-AC-06", [
    ["search facets", /facet/u], ["exact-version scope", /exact.{0,30}version/u], ["time scope", /time range|timecode|time-based/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-ARTIFACT-AC-07", [
    ["visual query", /visual or descriptive metadata query/u],
    ["unknown query/index outcome", /unknown|unavailable|unindexed/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-ARTIFACT-AC-08", [
    ["caption import", /caption/u], ["sidecar or embedded source", /sidecar|embedded/u],
    ["source-version provenance", /source version|version.{0,30}source/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-ARTIFACT-AC-09", [
    ["clip", /clip/u], ["source-time", /source.{0,30}time|time.{0,30}source/u], ["time range", /range|span/u],
    ["exact source version", /exact.{0,30}version|version.{0,30}exact/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-DELIVER-AC-04", [
    ["sidecar captions", /sidecar/u], ["embedded captions", /embedded/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-08", [
    ["segment", /segment/u], ["speaker assignment", /speaker/u], ["speaker authorization", /authori[sz]/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-MASTER-AUDIO-AC-04", [
    ["per-voice effect chain", /per.voice|voice.{0,40}(?:chain|effect)|(?:chain|effect).{0,40}voice/u],
    ["derived-audio provenance", /provenance/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-MASTER-AUDIO-AC-05", [
    ["5.1 or multichannel layout", /5\.1|multichannel/u], ["layout", /layout/u], ["unavailable support", /unavailable|unsupported/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-COMPOSE-AC-04", [
    ["gain", /gain/u], ["pan", /pan/u], ["automation", /automation/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-COMPOSE-AC-05", [
    ["speech-region editing", /speech.{0,80}region|region.{0,80}speech/u],
    ["crossfade", /crossfade/u], ["sample-time semantics", /sample.{0,20}time|sample-accurate/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-COMPOSE-AC-06", [
    ["free-space placement", /free.space|free space/u], ["placement", /placement/u], ["placement uncertainty", /uncertaint|unknown/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-COMPOSE-AC-07", [
    ["editable template", /editable/u], ["motion template", /motion.{0,20}template|template.{0,20}motion/u],
    ["brand identity", /brand/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-COMPOSE-AC-08", [
    ["ADR", /\badr\b/u], ["room tone", /room tone/u],
    ["captured source", /captur/u], ["generated source", /generat/u], ["capture/generation distinction", /distinguish|separate|versus|rather than|content.origin distinction/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-STREAM-AC-04", [
    ["stream capture", /governed capture session|stream.{0,30}captur|captur.{0,30}stream/u],
    ["capture does not imply commit", /does not imply|not imply|without (?:committing|commit)|does not (?:commit|persist)/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-AUDIO-ANALYSIS-AC-03", [
    ["beat grid", /beat grid/u], ["downbeat", /downbeat/u], ["tempo", /tempo/u], ["tempo uncertainty", /uncertaint|unknown/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-QUALITY-AC-10", [
    ["highlight", /highlight/u], ["source-time spans", /source.time|source time/u,], ["source-time range", /span|range/u],
    ["user objective", /user.{0,20}objective|declared objective/u], ["memorable score", /memorable/u], ["no default scoring", /default|automatic|assum/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-QUALITY-AC-11", [
    ["audience", /audience/u], ["channel", /channel/u], ["variant", /variant/u],
    ["variant link", /link|linked|source variant|bind each variant to the exact source candidate/u],
    ["ranking objective", /ranking objective|comparison objective|objective.{0,30}rank|rank.{0,30}objective/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-MULTIMODAL-AC-03", [
    ["source-grounded metadata candidates", /source.grounded|grounded in.{0,20}source|source.{0,20}evidence/u],
    ["title", /title/u], ["chapter", /chapter/u], ["description", /description/u], ["candidate", /candidate/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-ANIMATION-AC-04", [
    ["arbitrary", /arbitrary/u], ["custom shader", /custom shader|shader/u], ["unsupported outcome", /unsupported/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-COMPOSE-AC-11", [
    ["bus and send routing", /bus.{0,30}send|send.{0,30}bus/u], ["fader position", /pre\/post.fader/u],
    ["effect-chain identity", /effect.chain.{0,30}(?:version|identit)|(?:version|identit).{0,30}effect.chain/u],
    ["no commit or render", /without|leave.{0,40}unchanged|reject.{0,60}(?:commit|render)/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-QUALITY-AC-14", [
    ["audio fingerprint or similarity", /audio fingerprint|similarity/u], ["method and scope", /method.{0,40}scope|scope.{0,40}method/u],
    ["no legal conclusion", /ownership|infringement|legal clearance/u], ["separate rights decision", /rights.policy|rights decision/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-GENERATE-VIDEO-AC-04", [
    ["camera and lens controls", /camera.{0,40}lens|lens.{0,40}camera/u], ["synthetic status", /synthetic/u],
    ["unsupported and unknown controls", /unsupported.{0,50}unknown|unknown.{0,50}unsupported/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-GENERATE-VIDEO-AC-05", [
    ["versioned preset", /versioned preset/u], ["effective manifest", /effective parameter manifest/u],
    ["fresh admission", /fresh.{0,100}(?:authority|admission)|fresh.{0,30}admission/u], ["no replay", /does not replay|not replay/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-GENERATE-VIDEO-AC-06", [
    ["shot intervals", /shot intervals/u], ["per-shot prompts", /per.shot prompt/u], ["mask rights", /mask.{0,30}rights/u],
    ["no whole-clip application", /whole clip/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-JOB-AC-04", [
    ["watch-folder or recurrence", /watch.folder|recurrence/u], ["versioned schedule", /versioned schedule/u],
    ["per-occurrence admission", /each occurrence.{0,160}fresh admission/u], ["no cloud fallback", /cloud.{0,30}fallback/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-09", [
    ["requested and observed identity", /requested and observed speaker\/voice/u], ["exact output", /exact output/u],
    ["unknown mismatch", /mismatch.{0,30}unknown|unknown.{0,30}mismatch/u], ["no silent substitution", /silently substituting/u],
  ]);
});

test("PDP-0 audit support cases retain governed asset and generated-checkpoint boundaries", () => {
  const supportingCases = [
    "MEDIA-REQ-CAP-ARTIFACT-AC-05",
    "MEDIA-REQ-CAP-GENERATE-AUDIO-AC-05",
  ];
  for (const id of supportingCases) {
    const family = familyByCaseId.get(id);
    assert.ok(family, `${id} belongs to one canonical PDP-0 requirement family`);
    assert.ok(Array.isArray(family.capabilityIds) && family.capabilityIds.length > 0, `${id} parent lists canonical capability leaves`);
    assert.ok(family.phase === "PDP-0" || family.phase === undefined, `${id} remains PDP-0-owned`);
    caseText(id);
  }
  assertTerms("MEDIA-REQ-CAP-ARTIFACT-AC-05", [
    ["declared intended-use scope", /intended.use scope/u],
    ["exact version and current rights evidence", /immutable asset version.{0,120}current authoritative.{0,80}rights/u],
    ["unknown is not an empty result", /unknown or review.required rather than as an empty eligible result/u],
    ["no legal clearance", /legal clearance/u],
  ]);
  assertTerms("MEDIA-REQ-CAP-GENERATE-AUDIO-AC-05", [
    ["exact checkpoint identity and version", /exact checkpoint identity and version/u],
    ["checkpoint license and use scope", /license identity and use.scope terms/u],
    ["purpose compatibility", /declared purpose/u],
    ["similarity is not rights clearance", /similarity observation as rights clearance/u],
  ]);
});

test("PDP-0 retains all historical capability IDs and names each additive definition extension", () => {
  const ids = capabilities.capabilities.map(({ id }) => id);
  const historicalIds = capabilityLeafReview.ownerCapabilityLeafAdjudication.records.map(({ capabilityRef }) => capabilityRef);
  const extensionIds = campaignExtensions.currentDefinitionPopulation.records.map(({ capabilityId }) => capabilityId);
  const idsBeyondHistorical = ids.filter((id) => !historicalIds.includes(id)).sort();
  assert.equal(historicalIds.length, 462, "the historical owner-adjudication population stays at 462");
  assert.equal(new Set(historicalIds).size, 462, "historical capability identities remain unique");
  assert.ok(historicalIds.every((id) => ids.includes(id)), "all historical capability IDs remain present");
  assert.equal(ids.length, 469, "PDP-0 retains 462 historical leaves and seven explicit definition extensions");
  assert.equal(new Set(ids).size, 469, "current PDP-0 capability identities remain unique");
  assert.deepEqual(idsBeyondHistorical, extensionIds.slice().sort(), "every additive definition is explicitly recorded as an extension");
  assert.equal(campaignExtensions.currentDefinitionPopulation.ownerApproval, "NOT_CLAIMED");
  assert.equal(campaignExtensions.currentDefinitionPopulation.independentAcceptance, "NOT_CLAIMED");
  const requiredIds = [
    "media.recipe.specification.compile", "media.project.scene.patch-merge",
    "media.quality.audio.content-similarity.assess", "media.generate.video.preset.manage",
    "media.generate.video.shot-condition", "media.job.schedule.manage", "media.master.audio.creative-effect.apply",
  ];
  assert.deepEqual(extensionIds.slice().sort(), requiredIds.slice().sort(), "the seven P0 extensions have stable identities");
});
