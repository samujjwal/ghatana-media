import React from "react";
import { ArtifactIntakeScreen, type ArtifactIntakeScreenProps } from "./ArtifactIntakeScreen";
import { FirstUseProjectScreen, type FirstUseProjectScreenProps } from "./FirstUseProjectScreen";
import { JobRecoveryScreen, type JobRecoveryScreenProps } from "./JobRecoveryScreen";
import { TranscriptCaptionScreen, type TranscriptCaptionScreenProps } from "./TranscriptCaptionScreen";
import { MediaContractScreen, type MediaContractScreenProps } from "./MediaContractScreen";

/**
 * The single Media-owned renderer entry point for currently implemented web
 * presentation families. Host adapters project domain data and typed ports;
 * this package selects the admitted Media presentation implementation.
 */
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
