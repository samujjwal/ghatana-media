/**
 * Keep Media-owned definition contracts separate from public source/export
 * identity observations. Neither disposition establishes implementation,
 * qualification, Shared approval, or runtime admission.
 */
export function buildPdp3ComponentSourceDispositions(components, reuseAudit) {
  if (!Array.isArray(components) || !reuseAudit?.publicExportInventory) {
    throw new TypeError("PDP-3 component source disposition inputs are incomplete");
  }
  const contractOnly = new Set(reuseAudit.publicExportInventory.unboundFamilies ?? []);
  const sourceExport = new Set(reuseAudit.publicExportInventory.exactBindings ?? []);
  const seen = new Set();
  const rows = components.map((component) => {
    if (!component || typeof component.id !== "string" || seen.has(component.id)) {
      throw new TypeError("PDP-3 component source dispositions require unique component identities");
    }
    seen.add(component.id);
    if (contractOnly.has(component.id) === sourceExport.has(component.id)) {
      throw new Error(`Component ${component.id} must have exactly one source disposition`);
    }
    if (contractOnly.has(component.id)) {
      if (!component.typedDefinition || component.typedDefinition.runtimeAdmission !== "NOT_ADMITTED") {
        throw new Error(`Contract-only component ${component.id} lacks its bounded Media definition or NOT_ADMITTED marker`);
      }
      return {
        componentRef: component.id,
        disposition: "MEDIA_CONTRACT_ONLY_DEFINITION",
        typedDefinitionRef: `.product-experience/pdp-2-design-interface-system/component-contracts.yaml#components/@id=${component.id}/typedDefinition`,
        runtimeAdmission: "NOT_ADMITTED",
        qualification: "NOT_EVALUATED",
      };
    }
    return {
      componentRef: component.id,
      disposition: "EXACT_SOURCE_AND_PUBLIC_EXPORT_IDENTITY_OBSERVED",
      sourceRef: component.sourceRef ?? component.id,
      runtimeAdmission: "NOT_ADMITTED",
      qualification: "NOT_EVALUATED",
    };
  });
  if (seen.size !== contractOnly.size + sourceExport.size ||
      [...contractOnly, ...sourceExport].some((id) => !seen.has(id))) {
    throw new Error("Reuse audit component source disposition census does not match the component contract inventory");
  }
  return rows;
}
