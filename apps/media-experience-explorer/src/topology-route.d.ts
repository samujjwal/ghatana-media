export type TopologyRouteSelection = { kind: "root" | "composition" | "physical"; id: string };
export type TopologyRouteResult = { selection: TopologyRouteSelection | null; error: string | null };
export function isTopologyRoute(hash: string): boolean;
export function formatTopologyHash(selection: TopologyRouteSelection): string;
export function parseTopologyHash(hash: string, topology: {
  compositions: readonly { surfaceId: string; kind?: string }[];
  manifestCandidates: readonly { surfaceId: string }[];
}): TopologyRouteResult;
