import artifacts from "../specification-artifacts.json";

export type ExperiencePhase = "P0" | "P1" | "P2" | "P3" | "Cross-phase";

export interface SpecificationArtifact {
  readonly phase: ExperiencePhase;
  readonly path: string;
  readonly title: string;
}

export const specificationArtifacts: readonly SpecificationArtifact[] = Object.freeze(artifacts as SpecificationArtifact[]);
