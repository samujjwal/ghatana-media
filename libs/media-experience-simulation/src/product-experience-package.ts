import {
  createProductSessionState,
  type ExperienceContext,
  type ProductAction,
  type ProductEffectSet,
  type ProductExperiencePackage,
  type ProductRenderContext,
  type ProductSessionState,
} from "@ghatana/experience-package";
import { availableActionIds, createFixtureState, isMediaAction, mediaExperienceScenarioIds, projectExperience, reduceMediaExperience } from "./index.js";
import type { MediaExperienceState } from "./model.js";

/** Canonical Media source records represented by this deliberately scoped proposal adapter. */
export const MEDIA_EXPERIENCE_SOURCE_REFS = Object.freeze([
  ".product-experience/source-manifest.yaml",
  ".product-experience/pdp-0-product-truth/state-models.yaml",
  ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
  ".product-experience/pdp-3-product-experience/state-transition-bindings.yaml",
  ".product-experience/pdp-3-product-experience/simulation-semantics.yaml",
  ".product-experience/explorer/media-experience-package.yaml",
] as const);

const PDP3_PROPOSAL_STATUS = "proposal-pending-owner-review";
const DEFAULT_SCENARIO = "media.scenario.source-available" as const;
export const MEDIA_RENDERER_PUBLIC_EXPORT = "@audio-video/ui#MediaProductRenderer" as const;

export type MediaRendererCandidateVariant =
  | "first-use-project"
  | "artifact-intake"
  | "job-recovery"
  | "transcript-caption";

/** Data-only candidate contract carried by the public Tools render result. */
export interface MediaRendererBinding {
  readonly identity: typeof MEDIA_RENDERER_PUBLIC_EXPORT;
  readonly status: "CANDIDATE_NOT_ADMITTED";
  readonly rendererId: "media-simulation-review";
  readonly ports: {
    readonly input: {
      readonly type: "MediaProductRendererProps";
      readonly variant: MediaRendererCandidateVariant;
      readonly scenarioId: string;
    };
    readonly state: {
      readonly type: "MediaExperienceState";
      readonly stateRef: string;
      readonly sequence: number;
    };
    readonly action: {
      readonly type: "MediaActionPort";
      readonly actionIds: readonly string[];
    };
    readonly error: {
      readonly type: "MediaActionDispatchResult";
      readonly outcomes: readonly ["intent-accepted", "unavailable", "denied"];
    };
  };
}

function rendererVariant(state: MediaExperienceState): MediaRendererCandidateVariant {
  switch (state.workflow) {
    case "first-use": return "first-use-project";
    case "artifact-intake": return "artifact-intake";
    case "artifact-verification": return "job-recovery";
    case "transcription": return "transcript-caption";
  }
}

function rendererBinding(state: MediaExperienceState): MediaRendererBinding {
  return Object.freeze({
    identity: MEDIA_RENDERER_PUBLIC_EXPORT,
    status: "CANDIDATE_NOT_ADMITTED",
    rendererId: "media-simulation-review",
    ports: Object.freeze({
      input: Object.freeze({ type: "MediaProductRendererProps", variant: rendererVariant(state), scenarioId: state.scenarioId }),
      state: Object.freeze({ type: "MediaExperienceState", stateRef: state.scenarioId, sequence: state.sequence }),
      action: Object.freeze({ type: "MediaActionPort", actionIds: [...availableActionIds(state)] }),
      error: Object.freeze({ type: "MediaActionDispatchResult", outcomes: ["intent-accepted", "unavailable", "denied"] as const }),
    }),
  });
}

function readState(handle: ProductSessionState): MediaExperienceState {
  return (handle as unknown as { readonly _data: MediaExperienceState })._data;
}

function makeContext(context: ExperienceContext, state: MediaExperienceState): ProductRenderContext {
  return {
    experienceContext: context,
    productState: createProductSessionState(state),
    rendererId: "media-simulation-review",
  };
}

function projectSources(state: MediaExperienceState): Record<string, unknown> {
  return {
    ...projectExperience(state),
    sourceStatus: PDP3_PROPOSAL_STATUS,
    interpretation: "Deterministic Media fixture projection; proposal and unresolved PDP bindings remain non-authoritative.",
  };
}

/**
 * Media-owned adapter over the existing Media reducer and fixtures. The Tools
 * Explorer supplies generic context, load, render, inspect, and dispatch mechanics.
 */
export function createMediaProductExperiencePackage(): ProductExperiencePackage {
  const manifest: ProductExperiencePackage["manifest"] = Object.freeze({
    schemaVersion: "ghatana.product-experience.v1",
    packageId: "media.experience.simulation",
    subjectId: "media",
    displayName: "Media Experience Simulation",
    version: "0.1.0-SNAPSHOT",
    authority: Object.freeze({ mode: "DRAFT" }),
    contextDimensions: [
      { id: "workflow", semanticKind: "media-workflow", importance: "primary" },
      { id: "scenario", semanticKind: "deterministic-fixture", importance: "secondary" },
    ] as const,
    renderers: ["media-simulation-review"],
    supportedActions: [...new Set([
      ...mediaExperienceScenarioIds.flatMap((scenarioId) => availableActionIds(createFixtureState(scenarioId))),
      "media.action.correct-caption",
      "media.action.align-caption-timing",
      "media.action.resolve-caption-conflict",
      "media.action.save-caption-version",
      "media.action.request-transcription",
      "media.action.compare-caption-versions",
    ])],
    supportedSearchTypes: [],
    invariantIds: [],
  });

  return {
    manifest,

    resolveContext(context) {
      const scenarioDimension = context.contextDimensions.find(({ dimensionId }) => dimensionId === "scenario");
      const scenarioId = scenarioDimension?.value ?? DEFAULT_SCENARIO;
      let state: MediaExperienceState;
      try {
        state = createFixtureState(scenarioId as MediaExperienceState["scenarioId"]);
      } catch {
        state = createFixtureState(DEFAULT_SCENARIO);
      }
      return makeContext(context, state);
    },

    resumeContext(context, state) {
      readState(state);
      return {
        experienceContext: context,
        productState: state,
        rendererId: "media-simulation-review",
      };
    },

    render(context) {
      const state = readState(context.productState);
      return {
        rendererId: context.rendererId,
        kind: "rendered",
        output: {
          ...projectSources(state),
          rendererBinding: rendererBinding(state),
          presentationStatus: PDP3_PROPOSAL_STATUS,
          schemaInterpretation: "The Tools package schema validates the adapter contract; source record schemas remain separate proposal references.",
        },
      };
    },

    dispatch(action: ProductAction, context: ProductRenderContext): ProductEffectSet {
      const state = readState(context.productState);
      const mediaAction = { type: action.actionKind, ...(action.payload ?? {}) };
      if (!isMediaAction(mediaAction)) {
        return {
          correlationId: action.correlationId,
          effects: [],
        // Required Tools dispatch token for this fixture only; not a Lifecycle receipt.
        receipt: `simulation-transition:${state.sequence}:unsupported`,
          announcement: "This action shape is not supported by the Media simulation adapter.",
          finality: { kind: "unknown", reason: "Action shape is outside the Media simulation contract." },
          updatedState: context.productState,
        };
      }
      const transition = reduceMediaExperience(state, mediaAction);
      return {
        correlationId: action.correlationId,
        effects: transition.effectIds.map((effectKind) => ({ effectKind, data: { simulationOnly: true } })),
        // Required Tools dispatch token for this fixture only; not a Lifecycle receipt.
        receipt: `simulation-transition:${transition.state.sequence}:${action.actionKind}`,
        announcement: transition.message,
        ...(transition.applied ? { nextSafeActions: availableActionIds(transition.state) } : {}),
        finality: { kind: "unknown", reason: "Fixture transition only; canonical action finality remains unresolved." },
        updatedState: createProductSessionState(transition.state),
      };
    },

    inspect(context) {
      const state = readState(context.productState);
      const activeJourneyRefs = state.workflow === "first-use"
        ? ["J-01"]
        : state.workflow === "artifact-intake" || state.workflow === "artifact-verification"
          ? ["J-02"]
          : ["J-20", "J-03"];
      return {
        subjectId: "media",
        currentStateRef: state.scenarioId,
        activeJourneyRefs,
        availableActions: availableActionIds(state),
        specification: {
          stageId: "PDP-0..PDP-3-proposal-projection",
          artifactRefs: [...MEDIA_EXPERIENCE_SOURCE_REFS],
        },
        authority: {
          classification: "draft-proposal-projection",
          status: PDP3_PROPOSAL_STATUS,
          sourceRefs: [...MEDIA_EXPERIENCE_SOURCE_REFS],
        },
      };
    },
  };
}
