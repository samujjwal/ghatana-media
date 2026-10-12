const VALID_STATUSES = new Set([
  "LIVE_IMPLEMENTED",
  "LOCAL_SIMULATION",
  "CONTRACT_PREVIEW",
  "NOT_ADMITTED",
]);

const RUNTIME_BINDINGS = new Map([
  ["media.view.authenticate-and-select-context", "first-use-project:authenticate-and-select-context"],
  ["media.view.find-projects", "first-use-project:find-projects"],
  ["media.view.work-in-project", "first-use-project:work-in-project"],
  ["media.view.browse-media", "artifact-intake:browse-media"],
  ["media.view.inspect-media", "artifact-intake:inspect-media"],
  ["media.view.import-media", "artifact-intake:import-media"],
  ["media.view.job-status", "job-recovery:job-status"],
  ["media.view.check-job-outcome", "job-recovery:check-job-outcome"],
  ["media.view.select-source", "transcript-caption:select-source"],
  ["media.view.review-transcript", "transcript-caption:review-transcript"],
  ["media.view.correct-captions", "transcript-caption:correct-captions"],
  ["media.view.compare-caption-versions", "transcript-caption:compare-caption-versions"],
]);

function assertUnique(ids, sourceName) {
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) throw new Error(`${sourceName} contains duplicate screen IDs: ${[...new Set(duplicates)].join(", ")}`);
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

export function parseRegistryScreens(source) {
  const baseline = source.match(/^screens:\s*([\s\S]*?)^laneViews:/mu)?.[1] ?? "";
  const lane = source.match(/^laneViews:\s*([\s\S]*?)^coverage:/mu)?.[1] ?? "";
  if (!baseline || !lane) throw new Error("Canonical screen registry must contain screens and laneViews sections");
  const screens = [];
  for (const section of [baseline, lane]) {
    const records = section.split(/\n(?=- id: )/u).filter((record) => /^- id: /u.test(record));
    for (const record of records) {
      const id = record.match(/^- id:\s*(media\.view\.[a-z0-9-]+)\s*$/mu)?.[1];
      if (!id) throw new Error("Canonical screen registry contains a record without an exact media.view ID");
      screens.push({
        id,
        label: record.match(/^  label:\s*(.+)$/mu)?.[1]?.trim() ?? id,
        route: record.match(/^  route:\s*(.+)$/mu)?.[1]?.trim() ?? "Contextual route not specified",
      });
    }
  }
  assertUnique(screens.map(({ id }) => id), "Canonical screen registry");
  return screens;
}

export function parseComponentIds(source) {
  const block = source.match(/export const MEDIA_SCREEN_COMPONENTS\s*=\s*\{([\s\S]*?)\n\}\s+as const;/u)?.[1];
  if (!block) throw new Error("MediaContractScreen must export MEDIA_SCREEN_COMPONENTS");
  return [...block.matchAll(/^\s*['"](media\.view\.[a-z0-9-]+)['"]:\s*\{/gmu)].map((match) => match[1]);
}

export function parseLocalSimulationIds(source) {
  const block = source.match(/const locallySimulatedScreenIds\s*=\s*new Set<MediaContractScreenId>\(\[([\s\S]*?)\]\);/u)?.[1];
  if (!block) throw new Error("MediaProductRenderer must declare locallySimulatedScreenIds");
  return [...block.matchAll(/['"](media\.view\.[a-z0-9-]+)['"]/gu)].map((match) => match[1]);
}

export function buildScreenStatusMatrix({ registryScreens, componentIds, localSimulationIds, contractPreviewProductRoute, contractPreviewNetworkCapability = "NOT_CLAIMED" }) {
  const registryIds = registryScreens.map(({ id }) => id);
  assertUnique(registryIds, "Canonical screen registry");
  assertUnique(componentIds, "Media component map");
  assertUnique(localSimulationIds, "Local simulation bindings");
  const missingComponents = difference(registryIds, componentIds);
  const extraComponents = difference(componentIds, registryIds);
  if (missingComponents.length || extraComponents.length) {
    throw new Error(`Screen/component mismatch; missing: ${missingComponents.join(", ") || "none"}; extra: ${extraComponents.join(", ") || "none"}`);
  }
  const extraLocalBindings = difference(localSimulationIds, registryIds);
  if (extraLocalBindings.length) throw new Error(`Local simulation bindings have unknown screen IDs: ${extraLocalBindings.join(", ")}`);
  const missingRuntimeBindings = localSimulationIds.filter((id) => !RUNTIME_BINDINGS.has(id));
  const staleRuntimeBindings = difference([...RUNTIME_BINDINGS.keys()], localSimulationIds);
  if (missingRuntimeBindings.length || staleRuntimeBindings.length) {
    throw new Error(`Local simulation/runtime binding mismatch; missing: ${missingRuntimeBindings.join(", ") || "none"}; stale: ${staleRuntimeBindings.join(", ") || "none"}`);
  }
  if (contractPreviewProductRoute !== "NOT_ADMITTED" || contractPreviewNetworkCapability !== "NOT_CLAIMED") {
    throw new Error("Contract previews must keep productRoute NOT_ADMITTED; preview routes cannot claim runtime or network capability");
  }
  return registryScreens.map(({ id, label, route }) => {
    const local = localSimulationIds.includes(id);
    const status = local ? "LOCAL_SIMULATION" : "CONTRACT_PREVIEW";
    if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported screen status for ${id}: ${status}`);
    return Object.freeze({
      screenId: id,
      label,
      declaredRoute: route,
      status,
      runtimeBinding: local ? RUNTIME_BINDINGS.get(id) : "MediaContractScreen definition preview",
      productRoute: "NOT_ADMITTED",
      networkCapability: "NOT_CLAIMED",
    });
  });
}
