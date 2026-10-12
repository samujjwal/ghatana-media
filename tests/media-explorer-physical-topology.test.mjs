import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatTopologyHash, isTopologyRoute, parseTopologyHash } from "../apps/media-experience-explorer/src/topology-route.js";

const [app, topologySource, adapterSource] = await Promise.all([
  readFile(new URL("../apps/media-experience-explorer/src/main.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/media-experience-explorer/src/physical-topology.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/media-experience-explorer/src/lifecycle-pack-adapter.js", import.meta.url), "utf8"),
]);
const topology = JSON.parse(await readFile(new URL("../.product-experience/surfaces/media-physical-topology.v1.json", import.meta.url), "utf8"));

test("physical topology is one Explorer view with root, composition, and physical candidate selection", () => {
  assert.match(app, /id: "physical-topology", label: "Physical Topology"/u);
  assert.match(app, /Select a root, composition, or physical candidate/u);
  assert.match(app, /<optgroup label="Semantic compositions">/u);
  assert.match(app, /<optgroup label="Physical candidates">/u);
  assert.match(topologySource, /kind: "root" \| "composition" \| "physical"/u);
  assert.equal(topology.compositions.filter((entry) => entry.kind === "REPOSITORY_ROOT").length, 1);
  assert.equal(topology.manifestCandidates.length, topology.activeManifestCandidateCount);
});

test("selected node projection preserves declared applicability, authority references, and consumers", () => {
  assert.match(app, /Exact phase applicability/u);
  assert.match(app, /cell\.disposition/u);
  assert.match(app, /authorityRefs/u);
  assert.match(app, /consumersFor\(selection, node\)/u);
  assert.match(topologySource, /consumerCrosswalk\.filter/u);
  const physical = topology.manifestCandidates.find((entry) => entry.surfaceId === "media.physical.launcher");
  assert.ok(physical.consumerSurfaceRefs.length > 0);
  assert.ok(topology.consumerCrosswalk.some((consumer) => consumer.physicalRefs.includes(physical.surfaceId)));
});

test("hierarchical Lifecycle status and qualification limits stay explicit", () => {
  assert.equal(topology.lifecycleContractStatus.hierarchicalMediaContractStatus, "SOURCE_CANDIDATE_AVAILABLE_PUBLIC_ADMISSION_PENDING");
  assert.match(app, /Lifecycle source candidate · TEST_ONLY · native NOT_ADMITTED/u);
  assert.match(app, /Version-negotiated candidate adapter/u);
  assert.match(app, /do not assert deployment, production availability, runtime qualification/u);
  assert.match(adapterSource, /ghatana\.surface-experience-pack\.v1/u);
  assert.doesNotMatch(app, /Lifecycle API integration complete/u);
});

test("each root, composition, and physical node has a stable reloadable direct link", () => {
  const selections = [
    { kind: "root", id: topology.compositions.find((node) => node.kind === "REPOSITORY_ROOT").surfaceId },
    ...topology.compositions.filter((node) => node.kind !== "REPOSITORY_ROOT").map((node) => ({ kind: "composition", id: node.surfaceId })),
    ...topology.manifestCandidates.map((node) => ({ kind: "physical", id: node.surfaceId })),
  ];
  for (const selection of selections) {
    const hash = formatTopologyHash(selection);
    assert.equal(isTopologyRoute(hash), true);
    assert.deepEqual(parseTopologyHash(hash, topology), { selection, error: null });
  }
  assert.match(app, /history\.pushState\(\{ explorerMode: "physical-topology", topologySelection \}, "", formatTopologyHash\(topologySelection\)\)/u);
  assert.match(app, /Stable direct link to this node/u);
});

test("root aggregation deduplicates shared physical candidates by surface identity", () => {
  const rootNode = topology.compositions.find((node) => node.kind === "REPOSITORY_ROOT");
  const physicalIds = new Set(topology.manifestCandidates.map((node) => node.surfaceId));
  const compositionById = new Map(topology.compositions.map((node) => [node.surfaceId, node]));
  const members = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const composition = compositionById.get(id);
    if (composition) composition.children.forEach(visit);
    else if (physicalIds.has(id)) members.add(id);
  };
  rootNode.children.forEach(visit);
  assert.equal(members.size, topology.manifestCandidates.length);
  assert.equal(rootNode.children.filter((id) => physicalIds.has(id)).length, 7);
  assert.equal(rootNode.children.filter((id) => compositionById.get(id)?.kind !== undefined && id !== rootNode.surfaceId).length, 6);
});

test("malformed, incomplete, and missing-node links fail closed with a selectable root fallback", () => {
  const cases = ["#physical-topology/", "#physical-topology/physical", "#physical-topology/physical/%", "#physical-topology/physical/media.physical.absent"];
  for (const hash of cases) {
    const result = parseTopologyHash(hash, topology);
    assert.equal(result.selection.kind, "root");
    assert.ok(result.error);
  }
  assert.match(app, /topologyRouteError \? `<p class="topology-route-error" role="alert">/u);
});
