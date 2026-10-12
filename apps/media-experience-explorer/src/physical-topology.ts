import topology from "../../../.product-experience/surfaces/media-physical-topology.v1.json";

export type Applicability = {
  disposition: string;
  authorityRef?: string;
  authorityRefs?: readonly string[];
  rationale?: string;
  [key: string]: unknown;
};
export type TopologyNode = {
  surfaceId: string;
  name?: string;
  kind?: string;
  sourcePath?: string;
  manifestPath?: string;
  buildSystem?: string;
  deployability?: string;
  owner?: string;
  disposition?: string;
  dispositionRationale?: string;
  consumerSurfaceRefs?: readonly string[];
  consumerMappingState?: string;
  children?: readonly string[];
  phaseApplicability?: Record<string, Applicability>;
  [key: string]: unknown;
};
export const mediaPhysicalTopology = topology as unknown as {
  schemaVersion: string;
  sourceCut: string;
  activeManifestCandidateCount: number;
  manifestCandidates: readonly TopologyNode[];
  compositions: readonly TopologyNode[];
  consumerCrosswalk: readonly { surfaceId: string; consumerType: string; physicalRefs: readonly string[]; bindingState: string; statusReason: string; registryAuthority: string }[];
  lifecycleContractStatus: { hierarchicalMediaContractStatus: string; conclusion: string };
};

export type TopologySelection = { kind: "root" | "composition" | "physical"; id: string };
export const topologyRoot = mediaPhysicalTopology.compositions.find((item) => item.kind === "REPOSITORY_ROOT")!;

export function topologyNode(selection: TopologySelection): TopologyNode | undefined {
  if (selection.kind === "root") return topologyRoot;
  const records = selection.kind === "composition" ? mediaPhysicalTopology.compositions : mediaPhysicalTopology.manifestCandidates;
  return records.find((record) => record.surfaceId === selection.id);
}

export function applicabilityRelation(disposition: string): "DIRECT" | "REFERENCE" | "DECLARED" {
  if (/^(?:DIRECT_|APPLICABLE$|HEADLESS_|CONSUMER_CONTRACT$|TOOLING_OR_SUPPORT$)/u.test(disposition)) return "DIRECT";
  if (/REFERENCED|INHERITED|ROOT/u.test(disposition)) return "REFERENCE";
  return "DECLARED";
}

export function consumersFor(selection: TopologySelection, node: TopologyNode) {
  const descendants = (id: string, visited = new Set<string>()): string[] => {
    if (visited.has(id)) return [];
    visited.add(id);
    const composition = mediaPhysicalTopology.compositions.find((entry) => entry.surfaceId === id);
    return composition ? (composition.children ?? []).flatMap((childId) => descendants(childId, visited)) : [id];
  };
  const physicalIds = selection.kind === "physical" ? [node.surfaceId] : descendants(node.surfaceId);
  return mediaPhysicalTopology.consumerCrosswalk.filter((consumer) => consumer.physicalRefs.some((ref) => physicalIds.includes(ref)));
}
