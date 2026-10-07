import { createExplorer } from "@ghatana/product-dev-explorer";
import type { PackageReference } from "@ghatana/experience-explorer-contracts";
import { validateProductDefinition } from "@ghatana/product-definition";
import { validateProductExperiencePackage } from "@ghatana/experience-package";
import { projectProductDefinition } from "@ghatana/development-traceability";
import { createMediaProductExperiencePackage } from "@ghatana/media-experience-simulation";

const mediaPackageReference: PackageReference = Object.freeze({
  packageId: "media.experience.simulation",
  subjectId: "media",
  displayName: "Media Experience Simulation",
  source: "synthetic",
});

/**
 * Small Media consumer bridge that exercises the Tools-owned generic Explorer
 * API. It contains no Explorer workspace mechanics or product branching.
 */
export async function exerciseMediaToolsConsumer() {
  // Structural smoke fixtures exercise the published Tools validators. They
  // are not Media semantic acceptance records or generated product truth.
  // Synthetic structural fixture for public projector consumption only; this
  // is not a Media semantic acceptance record or owner decision.
  const syntheticProductDefinition = {
    id: "ghatana.product/media",
    subjectId: "media",
    schemaVersion: "ghatana.product-definition.v1",
    purpose: { id: "media-purpose-fixture", statement: "Validate the Media Tools consumer boundary.", forWhom: "Media product owners" },
    scope: { id: "media-scope-fixture", description: "Validator smoke fixture only.", inclusions: [], exclusions: [] },
    nonGoals: [],
    actors: [],
    responsibilities: [],
    userIntents: [],
    businessIntents: [],
    desiredOutcomes: [{ id: "synthetic-outcome", description: "Exercise outcome projection." }],
    capabilities: [{ id: "synthetic-capability", name: "Fixture capability", description: "Exercise capability projection.", requirementRefs: ["synthetic-requirement"] }],
    requirements: [{ id: "synthetic-requirement", statement: "Exercise requirement projection.", kind: "functional", priority: "should", capabilityRef: "synthetic-capability", traceToIntentIds: [] }],
    domainRules: [],
    policies: [],
    invariants: [],
    journeys: [],
    trustContexts: [],
    successMeasures: [],
    ownershipRules: [],
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
  } as const;
  validateProductDefinition(syntheticProductDefinition);
  const traceProjection = projectProductDefinition(syntheticProductDefinition);
  const mediaPackage = createMediaProductExperiencePackage();
  validateProductExperiencePackage(mediaPackage);

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
      diagnostics: explorer.diagnose(),
    });
  } finally {
    explorer.dispose();
  }
}
