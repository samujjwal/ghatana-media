/**
 * Governed end-to-end AI Voice production workflow.
 *
 * Users move through one outcome-oriented sequence—capture, inspect, process,
 * review, refine, approve, export—without navigating provider or service
 * topology. Runtime capability and consent truth determine action availability.
 *
 * @doc.type component
 * @doc.purpose Complete AI Voice production task flow
 * @doc.layer product
 * @doc.pattern TaskFlow
 */
import {
  MediaTaskFlow,
  type MediaTaskAction,
  type MediaTaskOperation,
  type MediaTaskStep,
  type MediaTaskStepId,
} from "@audio-video/ui";
import { Button } from "@ghatana/design-system";
import React, { useId, useMemo } from "react";
import { useSemanticColors } from "./useSemanticColors";

export type VoiceCapabilityState =
  | "ACTIVE"
  | "DEGRADED"
  | "RECOVERING"
  | "DISABLED"
  | "MISCONFIGURED"
  | "UNAVAILABLE";

export interface VoiceSourceSummary {
  readonly artifactId?: string;
  readonly fileName: string;
  readonly durationSeconds?: number;
  readonly qualityScore?: number;
  readonly classification?: string;
  readonly languageTag?: string;
}

export interface VoiceModelSummary {
  readonly id: string;
  readonly name: string;
  readonly qualityScore?: number;
  readonly version?: string;
  readonly consentReference?: string;
}

export interface VoiceConsentState {
  readonly rightsAttested: boolean;
  readonly consentReference?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface VoiceProductionWorkflowProps {
  readonly projectName: string;
  readonly currentStep: MediaTaskStepId;
  readonly completedSteps?: readonly MediaTaskStepId[];
  readonly source?: VoiceSourceSummary;
  readonly selectedModel?: VoiceModelSummary;
  readonly consent: VoiceConsentState;
  readonly capabilities: Readonly<
    Partial<Record<MediaTaskStepId, VoiceCapabilityState>>
  >;
  readonly operation?: MediaTaskOperation;
  readonly onStepChange?: (step: MediaTaskStepId) => void;
  readonly onSourceSelected?: (file: File) => void;
  readonly onRecordSource?: () => void;
  readonly onProcess?: () => void;
  readonly onApprove?: () => void;
  readonly onExport?: () => void;
  readonly onConsentChange?: (next: VoiceConsentState) => void;
  readonly onSaveDraft?: () => void;
  readonly renderStep?: (step: MediaTaskStepId) => React.ReactNode;
  readonly className?: string;
}

const STEP_DEFINITIONS: ReadonlyArray<{
  readonly id: MediaTaskStepId;
  readonly title: string;
  readonly description: string;
}> = [
  {
    id: "capture",
    title: "Capture or import",
    description: "Choose the source recording and confirm its intended use.",
  },
  {
    id: "inspect",
    title: "Inspect",
    description: "Review format, duration, language, quality, and classification.",
  },
  {
    id: "process",
    title: "Process",
    description: "Run separation, training, or conversion with observable progress.",
  },
  {
    id: "review",
    title: "Review",
    description: "Compare source and generated output before accepting changes.",
  },
  {
    id: "refine",
    title: "Refine",
    description: "Adjust phrases, stems, takes, timing, and mix settings.",
  },
  {
    id: "approve",
    title: "Approve",
    description: "Confirm quality, provenance, rights, and consent evidence.",
  },
  {
    id: "export",
    title: "Export",
    description: "Create a governed artifact with version and provenance metadata.",
  },
] as const;

function unavailableReason(
  capability: VoiceCapabilityState | undefined,
): string | undefined {
  if (!capability || capability === "ACTIVE") return undefined;
  if (capability === "DEGRADED") {
    return "This capability is degraded. Review runtime guidance before continuing.";
  }
  if (capability === "RECOVERING") {
    return "This capability is recovering and cannot start new work yet.";
  }
  if (capability === "MISCONFIGURED") {
    return "This capability requires administrator configuration.";
  }
  if (capability === "DISABLED") {
    return "This capability is disabled in the active deployment profile.";
  }
  return "This capability is unavailable in the active deployment.";
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "Not reported";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function VoiceProductionWorkflow({
  projectName,
  currentStep,
  completedSteps = [],
  source,
  selectedModel,
  consent,
  capabilities,
  operation,
  onStepChange,
  onSourceSelected,
  onRecordSource,
  onProcess,
  onApprove,
  onExport,
  onConsentChange,
  onSaveDraft,
  renderStep,
  className,
}: VoiceProductionWorkflowProps): React.ReactElement {
  const colors = useSemanticColors();
  const fileInputId = useId();
  const consentReferenceId = useId();
  const completed = useMemo(() => new Set(completedSteps), [completedSteps]);
  const sourceReady = Boolean(source?.artifactId || source?.fileName);
  const processed =
    completed.has("process") ||
    completed.has("review") ||
    completed.has("refine") ||
    completed.has("approve") ||
    completed.has("export");
  const approved = completed.has("approve") || completed.has("export");
  const consentComplete =
    consent.rightsAttested && Boolean(consent.consentReference?.trim());

  const steps: readonly MediaTaskStep[] = STEP_DEFINITIONS.map((definition) => {
    const capabilityReason = unavailableReason(capabilities[definition.id]);
    let prerequisiteReason: string | undefined;
    if (definition.id !== "capture" && !sourceReady) {
      prerequisiteReason = "Capture or import a source recording first.";
    } else if (
      ["review", "refine", "approve", "export"].includes(definition.id) &&
      !processed
    ) {
      prerequisiteReason = "Complete media processing before this step.";
    } else if (definition.id === "export" && !approved) {
      prerequisiteReason = "Approve quality, provenance, and consent before export.";
    }
    const blockedReason = capabilityReason ?? prerequisiteReason;
    return {
      ...definition,
      state: blockedReason
        ? "blocked"
        : definition.id === currentStep
          ? "current"
          : completed.has(definition.id)
            ? "complete"
            : "available",
      ...(blockedReason ? { blockedReason } : {}),
    };
  });

  const primaryAction = useMemo((): MediaTaskAction | undefined => {
    switch (currentStep) {
      case "capture":
        return onRecordSource
          ? {
              id: "record-source",
              label: "Record source audio",
              onAction: onRecordSource,
              disabled: Boolean(unavailableReason(capabilities.capture)),
              disabledReason: unavailableReason(capabilities.capture),
            }
          : undefined;
      case "inspect":
      case "process":
        return onProcess
          ? {
              id: "process-source",
              label: processed ? "Process again" : "Start processing",
              onAction: onProcess,
              disabled: !sourceReady || Boolean(unavailableReason(capabilities.process)),
              disabledReason:
                (!sourceReady ? "Capture or import a source recording first." : undefined) ??
                unavailableReason(capabilities.process),
            }
          : undefined;
      case "review":
      case "refine":
        return onStepChange
          ? {
              id: "continue-approval",
              label: "Continue to approval",
              onAction: () => onStepChange("approve"),
              disabled: !processed,
              disabledReason: !processed
                ? "Complete media processing before approval."
                : undefined,
            }
          : undefined;
      case "approve":
        return onApprove
          ? {
              id: "approve-output",
              label: "Approve output",
              onAction: onApprove,
              disabled:
                !processed ||
                !consentComplete ||
                Boolean(unavailableReason(capabilities.approve)),
              disabledReason:
                (!processed
                  ? "Complete processing and review first."
                  : !consentComplete
                    ? "Record rights attestation and a consent reference before approval."
                    : undefined) ?? unavailableReason(capabilities.approve),
            }
          : undefined;
      case "export":
        return onExport
          ? {
              id: "export-output",
              label: "Export governed artifact",
              onAction: onExport,
              disabled: !approved || Boolean(unavailableReason(capabilities.export)),
              disabledReason:
                (!approved ? "Approve the output before export." : undefined) ??
                unavailableReason(capabilities.export),
            }
          : undefined;
      default:
        return undefined;
    }
  }, [
    approved,
    capabilities,
    consentComplete,
    currentStep,
    onApprove,
    onExport,
    onProcess,
    onRecordSource,
    onStepChange,
    processed,
    sourceReady,
  ]);

  const secondaryActions: readonly MediaTaskAction[] = [
    ...(onSaveDraft
      ? [
          {
            id: "save-draft",
            label: "Save project draft",
            onAction: onSaveDraft,
          },
        ]
      : []),
  ];

  const defaultContent = (): React.ReactNode => {
    switch (currentStep) {
      case "capture":
        return (
          <div className="space-y-4">
            <label htmlFor={fileInputId} className="grid gap-2 text-sm font-medium">
              Import source audio
              <input
                id={fileInputId}
                type="file"
                accept="audio/*"
                disabled={!onSourceSelected}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onSourceSelected?.(file);
                }}
                className="min-h-11 rounded-lg border p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2"
                style={{ borderColor: colors.border, color: colors.content }}
              />
            </label>
            <p className="text-xs" style={{ color: colors.contentSecondary }}>
              Upload validation must confirm type, size, checksum, classification,
              retention, and tenant ownership before processing begins.
            </p>
          </div>
        );
      case "inspect":
        return source ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <dt className="text-xs" style={{ color: colors.contentSecondary }}>Source</dt>
              <dd className="mt-1 font-medium">{source.fileName}</dd>
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-xs" style={{ color: colors.contentSecondary }}>Duration</dt>
              <dd className="mt-1 font-medium">
                {formatDuration(source.durationSeconds)}
              </dd>
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-xs" style={{ color: colors.contentSecondary }}>Quality</dt>
              <dd className="mt-1 font-medium">
                {source.qualityScore === undefined
                  ? "Not evaluated"
                  : `${Math.round(source.qualityScore * 100)}%`}
              </dd>
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-xs" style={{ color: colors.contentSecondary }}>Classification</dt>
              <dd className="mt-1 font-medium">
                {source.classification ?? "Not reported"}
              </dd>
            </div>
          </dl>
        ) : (
          <p role="status">No source has been selected.</p>
        );
      case "process":
        return (
          <div className="space-y-3 text-sm">
            <p>
              Processing uses the selected capability and preserves provider,
              model, version, input artifact, output artifact, and correlation
              identity.
            </p>
            {selectedModel && (
              <p className="rounded-lg border p-3">
                Model: <strong>{selectedModel.name}</strong>
                {selectedModel.version ? ` · version ${selectedModel.version}` : ""}
              </p>
            )}
          </div>
        );
      case "review":
        return (
          <div className="space-y-3 text-sm">
            <p>
              Compare source and output, listen for artifacts, review phrase and
              timing changes, and confirm that no protected content was introduced.
            </p>
            <p
              className="rounded-lg border p-3"
              style={{ borderColor: colors.warning, backgroundColor: colors.warningSubtle, color: colors.warningOn }}
            >
              Generated audio remains a draft until explicit approval.
            </p>
          </div>
        );
      case "refine":
        return (
          <p className="text-sm">
            Use waveform, phrase, take, stem, volume, and pan controls to refine
            the result. Save a draft before changing models or source artifacts.
          </p>
        );
      case "approve":
        return (
          <fieldset className="space-y-4">
            <legend className="font-semibold">Rights and consent evidence</legend>
            <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                checked={consent.rightsAttested}
                disabled={!onConsentChange}
                onChange={(event) =>
                  onConsentChange?.({
                    ...consent,
                    rightsAttested: event.target.checked,
                  })
                }
                className="mt-0.5 h-5 w-5"
              />
              <span>
                I confirm that the organization has the necessary rights and
                consent to train, transform, and export this voice.
              </span>
            </label>
            <label htmlFor={consentReferenceId} className="grid gap-2 text-sm font-medium">
              Consent or rights reference
              <input
                id={consentReferenceId}
                type="text"
                value={consent.consentReference ?? ""}
                disabled={!onConsentChange}
                onChange={(event) =>
                  onConsentChange?.({
                    ...consent,
                    consentReference: event.target.value,
                  })
                }
                placeholder="Approval, contract, or consent record ID"
                className="min-h-11 rounded-lg border px-3"
                style={{ borderColor: colors.border, backgroundColor: colors.surface, color: colors.content }}
              />
            </label>
          </fieldset>
        );
      case "export":
        return (
          <div className="space-y-3 text-sm">
            <p>
              Export creates a governed artifact linked to this project, source,
              model, consent reference, processing job, and approval identity.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Versioned output artifact</li>
              <li>Checksum and media metadata</li>
              <li>Provider and model provenance</li>
              <li>Rights and approval evidence</li>
            </ul>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <MediaTaskFlow
      title={projectName}
      description="Create a governed voice output from source capture through explicit review, rights approval, and export."
      steps={steps}
      currentStepId={currentStep}
      onStepSelect={onStepChange}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
      operation={operation}
      className={className}
      summary={
        <dl className="space-y-2">
          <div>
            <dt className="text-xs" style={{ color: colors.contentSecondary }}>Source</dt>
            <dd>{source?.fileName ?? "Not selected"}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: colors.contentSecondary }}>Model</dt>
            <dd>{selectedModel?.name ?? "Not selected"}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: colors.contentSecondary }}>Rights evidence</dt>
            <dd>{consentComplete ? "Complete" : "Required before approval"}</dd>
          </div>
        </dl>
      }
    >
      {renderStep?.(currentStep) ?? defaultContent()}
    </MediaTaskFlow>
  );
}
