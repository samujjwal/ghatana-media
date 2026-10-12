export function isTopologyRoute(hash) {
  return hash === "#physical-topology" || hash.startsWith("#physical-topology/");
}

export function formatTopologyHash(selection) {
  return `#physical-topology/${selection.kind}/${encodeURIComponent(selection.id)}`;
}

export function parseTopologyHash(hash, topology) {
  const root = topology.compositions.find((node) => node.kind === "REPOSITORY_ROOT");
  if (!root) return { selection: null, error: "The crosswalk does not declare a repository root." };
  if (hash === "#physical-topology") return { selection: { kind: "root", id: root.surfaceId }, error: null };
  const parts = hash.slice("#physical-topology/".length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { selection: { kind: "root", id: root.surfaceId }, error: "This topology link is incomplete. Select a node to create a valid direct link." };
  }
  let id;
  try { id = decodeURIComponent(parts[1]); }
  catch { return { selection: { kind: "root", id: root.surfaceId }, error: "This topology link has an invalid encoded node ID. Select a node to create a valid direct link." }; }
  const kind = parts[0];
  const exists = kind === "root" ? id === root.surfaceId
    : kind === "composition" ? topology.compositions.some((node) => node.kind !== "REPOSITORY_ROOT" && node.surfaceId === id)
      : kind === "physical" ? topology.manifestCandidates.some((node) => node.surfaceId === id)
        : false;
  if (!exists) return { selection: { kind: "root", id: root.surfaceId }, error: "This topology link names a missing node. Select a node to return to a valid source record." };
  return { selection: { kind, id }, error: null };
}
