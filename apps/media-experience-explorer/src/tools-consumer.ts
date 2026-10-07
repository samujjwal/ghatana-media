import { createExplorer } from "@ghatana/product-dev-explorer";
import type { PackageReference } from "@ghatana/experience-explorer-contracts";
import { validateProductDefinition } from "@ghatana/product-definition";
import { validateProductExperiencePackage } from "@ghatana/experience-package";
import { projectProductDefinition } from "@ghatana/development-traceability";
import { createMediaProductExperiencePackage } from "@ghatana/media-experience-simulation";

const mediaPackageReference: PackageReference = Object.freeze({
  packageId: "media.experience.simulation",
  subjectId: "media",
  displayName: "Media Experience Package (proposal adapter)",
  manifestPath: ".product-experience/explorer/media-experience-package.yaml",
  source: "path",
});

// Load the authorities named by the Media package binding through the same
// source endpoint used by Specification mode. These are source records, not
// parsed/accepted semantics; unresolved bindings remain visible as blockers.
const MEDIA_AUTHORITIES = Object.freeze([
  ".product-experience/source-manifest.yaml",
  ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md",
  ".product-experience/pdp-0-product-truth/capabilities.yaml",
  ".product-experience/pdp-0-product-truth/state-models.yaml",
  ".product-experience/pdp-1-domain-data/presentation-projections.yaml",
  ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
  ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
  ".product-experience/pdp-3-product-experience/screen-registry.yaml",
  ".product-experience/pdp-3-product-experience/journey-registry.yaml",
  ".product-experience/pdp-3-product-experience/action-registry.yaml",
  ".product-experience/explorer/media-experience-package.yaml",
  ".product-experience/explorer/verification-matrix.yaml",
] as const);

async function loadMediaAuthorities(): Promise<readonly { path: string; content: string }[]> {
  // Node consumer checks exercise the package API without a browser origin;
  // the browser host loads these same indexed files and renders them.
  if (typeof document === "undefined") return [];
  return Promise.all(MEDIA_AUTHORITIES.map(async (path) => {
    const relative = path.replace(".product-experience/", "");
    const response = await fetch(new URL(`specification/${encodeURI(relative)}`, document.baseURI));
    if (!response.ok) throw new Error(`Unable to load Media authority ${path} (HTTP ${response.status}).`);
    return Object.freeze({ path, content: await response.text() });
  }));
}

/**
 * Small Media consumer bridge that exercises the Tools-owned generic Explorer
 * API. It contains no Explorer workspace mechanics or product branching.
 */
export async function exerciseMediaToolsConsumer() {
  const authorities = await loadMediaAuthorities();
  // No canonical ProductDefinition instance is published in the Media source
  // tree yet. Do not manufacture one from partial YAML or treat the structural
  // validator as semantic verification.
  const mediaPackage = createMediaProductExperiencePackage();
  validateProductExperiencePackage(mediaPackage);
  // Keep a clearly scoped structural consumer check for the trace projector.
  // This fixture is never shown as Media Product Truth or semantic evidence.
  const structuralTraceFixture = {
    id: "ghatana.product/media", subjectId: "media", schemaVersion: "ghatana.product-definition.v1",
    purpose: { id: "fixture-purpose", statement: "Structural consumer check only.", forWhom: "test" },
    scope: { id: "fixture-scope", description: "Not canonical Product Truth.", inclusions: [], exclusions: [] },
    nonGoals: [], actors: [], responsibilities: [], userIntents: [], businessIntents: [],
    desiredOutcomes: [{ id: "fixture-outcome", description: "Structural projection check." }],
    capabilities: [{ id: "fixture-capability", name: "Fixture capability", description: "Structural projection check.", requirementRefs: ["fixture-requirement"] }],
    requirements: [{ id: "fixture-requirement", statement: "Structural projection check.", kind: "functional", priority: "should", capabilityRef: "fixture-capability", traceToIntentIds: [] }],
    domainRules: [], policies: [], invariants: [], journeys: [], trustContexts: [], successMeasures: [], ownershipRules: [],
    createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z",
  } as const;
  validateProductDefinition(structuralTraceFixture);
  const traceProjection = projectProductDefinition(structuralTraceFixture);

  let sessionSequence = 0;
  const explorer = createExplorer({
    sessionIdFactory: () => `media-tools-consumer-review-${++sessionSequence}`,
    now: () => 1_797_000_000_000,
  });
  try {
    explorer.loader.register(mediaPackageReference, mediaPackage);
    await explorer.loadPackage(mediaPackageReference);
    const initialRender = explorer.render();
    const initialInspection = explorer.inspect();
    const initialOutput = initialRender?.output as { readonly sourceStatus?: string } | undefined;
    const transition = explorer.dispatch({
      actionKind: "media.action.choose-source",
      correlationId: "media-tools-consumer-choose-source",
    });
    const updatedRender = explorer.render();
    const updatedInspection = explorer.inspect();
    const updatedOutput = updatedRender?.output as { readonly sourceStatus?: string } | undefined;
    const updatedOutputRecord = updatedRender?.output as Readonly<Record<string, unknown>> | undefined;
    const currentnessOutputPresent = Boolean(
      updatedInspection && Object.prototype.hasOwnProperty.call(updatedInspection, "currentness") ||
      updatedOutputRecord && Object.prototype.hasOwnProperty.call(updatedOutputRecord, "currentness"),
    );

    return Object.freeze({
      activePackageId: explorer.state.activePackageId,
      toolsValidatorsPassed: true,
      traceProjection: {
        sourceId: traceProjection.sourceId,
        subjectId: traceProjection.subjectId,
        stageId: traceProjection.stageId,
        nodeKinds: traceProjection.nodes.map((node) => node.kind),
        relationCount: traceProjection.relations.length,
      },
      initialRenderKind: initialRender?.kind ?? null,
      initialSourceStatus: initialOutput?.sourceStatus ?? null,
      initialStateRef: initialInspection?.currentStateRef ?? null,
      dispatchProducedResult: transition !== null,
      dispatchFinalityKind: transition?.finality.kind ?? null,
      updatedRenderKind: updatedRender?.kind ?? null,
      updatedSourceStatus: updatedOutput?.sourceStatus ?? null,
      updatedStateRef: updatedInspection?.currentStateRef ?? null,
      updatedAvailableActions: updatedInspection?.availableActions ?? [],
      authorityStatus: updatedInspection?.authority?.status ?? null,
      currentnessOutputPresent,
      sourceRefs: updatedInspection?.authority?.sourceRefs ?? [],
      authorities,
      productDefinitionStatus: "BLOCKED: canonical ProductDefinition instance is not published; Product Truth YAML is shown as source authority only.",
      blockers: [
        "PDP-0 through PDP-3 sources remain proposals; no Lifecycle acceptance/currentness receipt is present.",
        "The Media package binding declares a scoped fixture adapter; it is not a complete admitted product package.",
        "PDP-2 template/layout to PDP-3 screen bindings are proposals and require owner review; candidate shared screens are not admitted renderings.",
        "Tools phase-verification support is not verified by the named public package contracts.",
      ],
      diagnostics: explorer.diagnose(),
    });
  } finally {
    explorer.dispose();
  }
}
