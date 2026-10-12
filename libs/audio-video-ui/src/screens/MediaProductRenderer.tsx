import React from "react";
import { ArtifactIntakeScreen, type ArtifactIntakeScreenProps } from "./ArtifactIntakeScreen";
import { FirstUseProjectScreen, type FirstUseProjectScreenProps } from "./FirstUseProjectScreen";
import { JobRecoveryScreen, type JobRecoveryScreenProps } from "./JobRecoveryScreen";
import { TranscriptCaptionScreen, type TranscriptCaptionScreenProps } from "./TranscriptCaptionScreen";
import { MediaContractScreen, type MediaContractScreenProps } from "./MediaContractScreen";

/**
 * The single Media-owned renderer entry point for implemented presentation
 * families and definition-only contract previews. Host adapters project data
 * and typed ports; selecting an implemented renderer does not admit a product
 * route, runtime, provider, or deployment.
 */
export const MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS = {
  "first-use-project": { renderer: "IMPLEMENTED", productRoute: "NOT_ADMITTED" },
  "artifact-intake": { renderer: "IMPLEMENTED", productRoute: "NOT_ADMITTED" },
  "job-recovery": { renderer: "IMPLEMENTED", productRoute: "NOT_ADMITTED" },
  "transcript-caption": { renderer: "IMPLEMENTED", productRoute: "NOT_ADMITTED" },
  "contract-screen": { renderer: "DEFINITION_ONLY_PREVIEW", productRoute: "NOT_ADMITTED" },
} as const;

export type MediaProductRendererProps =
  | ({ readonly kind: "first-use-project" } & FirstUseProjectScreenProps)
  | ({ readonly kind: "artifact-intake" } & ArtifactIntakeScreenProps)
  | ({ readonly kind: "job-recovery" } & JobRecoveryScreenProps)
  | ({ readonly kind: "transcript-caption" } & TranscriptCaptionScreenProps)
  | ({ readonly kind: "contract-screen" } & MediaContractScreenProps);

export function MediaProductRenderer(props: MediaProductRendererProps): React.ReactElement {
  switch (props.kind) {
    case "first-use-project": {
      const { kind: _kind, ...screenProps } = props;
      return <FirstUseProjectScreen {...screenProps} />;
    }
    case "artifact-intake": {
      const { kind: _kind, ...screenProps } = props;
      return <ArtifactIntakeScreen {...screenProps} />;
    }
    case "job-recovery": {
      const { kind: _kind, ...screenProps } = props;
      return <JobRecoveryScreen {...screenProps} />;
    }
    case "transcript-caption": {
      const { kind: _kind, ...screenProps } = props;
      return <TranscriptCaptionScreen {...screenProps} />;
    }
    case "contract-screen": {
      const { kind: _kind, ...screenProps } = props;
      return <MediaContractScreen {...screenProps} />;
    }
    default: {
      const unreachable: never = props;
      throw new Error(`Unsupported Media presentation: ${String(unreachable)}`);
    }
  }
}
