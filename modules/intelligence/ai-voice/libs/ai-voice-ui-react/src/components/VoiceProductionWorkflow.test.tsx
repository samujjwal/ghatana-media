import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TrainingProgress } from "./TrainingProgress";
import { VoiceProductionWorkflow } from "./VoiceProductionWorkflow";

const activeCapabilities = {
  capture: "ACTIVE",
  inspect: "ACTIVE",
  process: "ACTIVE",
  review: "ACTIVE",
  refine: "ACTIVE",
  approve: "ACTIVE",
  export: "ACTIVE",
} as const;

const exactSourceVersion = {
  tenantId: "tenant-1",
  artifactId: "source-1",
  versionId: "version-7",
} as const;

describe("VoiceProductionWorkflow", () => {
  it("reuses the CSP-safe Media progress primitive for voice training", () => {
    const html = renderToStaticMarkup(
      <TrainingProgress status="training" progress={32} />,
    );

    expect(html).toMatch(/<progress[^>]*class="media-progress media-progress--primary"/);
    expect(html).toContain('aria-label="Voice-model training progress"');
    expect(html).toContain('aria-valuetext="Training voice model, 32 percent"');
    expect(html).not.toMatch(/<progress[^>]*style=/);
  });

  it("keeps heading and status references unique across training jobs", () => {
    const html = renderToStaticMarkup(
      <>
        <TrainingProgress status="training" progress={32} modelName="Narrator" onCancel={vi.fn()} />
        <TrainingProgress status="preprocessing" progress={12} modelName="Guide" onCancel={vi.fn()} />
      </>,
    );
    const labelledBy = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    const describedBy = [...html.matchAll(/aria-describedby="([^"]+-voice-training-status)"/g)].map((match) => match[1]);
    const cancelDescriptionIds = [...html.matchAll(/aria-describedby="([^"]+-voice-training-cancel-note)"/g)].map((match) => match[1]);

    expect(labelledBy).toHaveLength(2);
    expect(new Set(labelledBy).size).toBe(2);
    expect(describedBy).toHaveLength(2);
    expect(new Set(describedBy).size).toBe(2);
    expect(cancelDescriptionIds).toHaveLength(2);
    expect(new Set(cancelDescriptionIds).size).toBe(2);
    for (const id of [...labelledBy, ...describedBy]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const id of cancelDescriptionIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("renders the complete outcome-oriented workflow", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="capture"
        consent={{ rightsAttested: false }}
        capabilities={activeCapabilities}
      />,
    );

    for (const label of [
      "Capture or import",
      "Inspect",
      "Process",
      "Review",
      "Refine",
      "Approve",
      "Export",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Create a governed voice output");
  });

  it("keeps approval blocked when source authority and rights attestation are missing", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="approve"
        completedSteps={["process", "review"]}
        source={{ artifactVersionRef: exactSourceVersion, artifactId: "source-1", fileName: "source.wav" }}
        consent={{ rightsAttested: false }}
        capabilities={activeCapabilities}
        onApprove={vi.fn()}
      />,
    );

    expect(html).toContain("current workspace, tenant, source version, and voice authority are not verified");
    expect(html).toContain("User assertion required before review");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Approve output");
  });

  it("does not admit export from approval and a supplied source tuple alone", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="export"
        completedSteps={["process", "review", "approve"]}
        source={{ artifactVersionRef: exactSourceVersion, artifactId: "source-1", fileName: "source.wav" }}
        selectedModel={{ id: "model-1", name: "Narrator", version: "2" }}
        consent={{
          rightsAttested: true,
          consentReference: "consent-1",
          approvedBy: "reviewer-1",
        }}
        capabilities={activeCapabilities}
        onExport={vi.fn()}
      />,
    );

    expect(html).toContain("Export governed artifact");
    expect(html).toContain("Provider and model provenance");
    expect(html).toContain('disabled=""');
    expect(html).toContain("current workspace, tenant, source version, and voice authority are not verified");
  });

  it("explains runtime capability blockers instead of hiding the step", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ artifactVersionRef: exactSourceVersion, artifactId: "source-1", fileName: "source.wav" }}
        consent={{ rightsAttested: false }}
        capabilities={{ ...activeCapabilities, process: "RECOVERING" }}
        onProcess={vi.fn()}
      />,
    );

    expect(html).toContain("recovering and cannot start new work yet");
  });

  it.each([
    ["UNKNOWN", "Current capability readiness is unknown"],
    ["NOT_ADMITTED", "NOT_ADMITTED for the current host"],
    ["DENIED", "denied for the current request"],
  ] as const)("blocks processing when readiness is %s", (state, reason) => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ artifactId: "source-1", fileName: "source.wav" }}
        consent={{ rightsAttested: false }}
        capabilities={{ ...activeCapabilities, process: state }}
        onProcess={vi.fn()}
      />,
    );

    expect(html).toContain("Start processing");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain(reason);
  });

  it("does not treat a selected filename as a validated immutable processing source", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ fileName: "selected-but-not-uploaded.wav" }}
        consent={{ rightsAttested: false }}
        capabilities={activeCapabilities}
        onProcess={vi.fn()}
      />,
    );

    expect(html).toContain("Start processing");
    expect(html).toContain('disabled=""');
    expect(html).toContain(
      "Provide the exact tenant, artifact, and version identity, then have the host verify the current source and voice authority before any operation.",
    );
  });

  it.each([
    ["missing reference", undefined],
    ["blank tenant", { ...exactSourceVersion, tenantId: " " }],
    ["blank artifact", { ...exactSourceVersion, artifactId: "" }],
    ["blank version", { ...exactSourceVersion, versionId: "\t" }],
  ] as const)("blocks processing for an incomplete exact source version: %s", (_case, artifactVersionRef) => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ artifactId: "source-1", fileName: "source.wav", artifactVersionRef }}
        consent={{ rightsAttested: false }}
        capabilities={activeCapabilities}
        onProcess={vi.fn()}
      />,
    );

    expect(html).toContain("Start processing");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Provide the exact tenant, artifact, and version identity");
  });

  it.each(["process", "review", "refine", "approve", "export"] as const)(
    "keeps the %s action disabled when the current source has no exact version tuple",
    (currentStep) => {
      const html = renderToStaticMarkup(
        <VoiceProductionWorkflow
          projectName="Voice campaign"
          currentStep={currentStep}
          completedSteps={["process", "review", "refine", "approve"]}
          source={{ artifactId: "source-1", fileName: "source.wav" }}
          consent={{ rightsAttested: true, consentReference: "consent-1" }}
          capabilities={activeCapabilities}
          onProcess={vi.fn()}
          onStepChange={vi.fn()}
          onApprove={vi.fn()}
          onExport={vi.fn()}
        />,
      );

      expect(html).toContain('disabled=""');
      expect(html).toContain("exact tenant, artifact, and version identity");
    },
  );

  it("displays an exact version tuple as provided and unverified", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="inspect"
        source={{ artifactVersionRef: exactSourceVersion, fileName: "source.wav" }}
        consent={{ rightsAttested: false }}
        capabilities={activeCapabilities}
        onStepChange={vi.fn()}
      />,
    );

    expect(html).toContain("Source version reference (provided, not verified)");
    expect(html).toContain("tenant-1 / source-1 / version-7");
  });

  it("keeps process disabled even with a complete tuple until trusted exact-target authority is available", () => {
    const onProcess = vi.fn();
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ artifactVersionRef: exactSourceVersion, fileName: "source.wav" }}
        consent={{ rightsAttested: true, consentReference: "consent-1" }}
        capabilities={activeCapabilities}
        onProcess={onProcess}
      />,
    );

    expect(html).toContain("Start processing");
    expect(html).toContain('disabled=""');
    expect(html).toContain("current workspace, tenant, source version, and voice authority are not verified");
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("fails closed when no current capability observation is supplied", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ artifactVersionRef: exactSourceVersion, artifactId: "source-1", fileName: "source.wav" }}
        consent={{ rightsAttested: false }}
        capabilities={{}}
        onProcess={vi.fn()}
      />,
    );

    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Current capability readiness is unknown");
  });

  it.each([
    [undefined, "Host capability observation for process: UNKNOWN."],
    ["UNKNOWN", "Host capability observation for process: UNKNOWN."],
    ["NOT_ADMITTED", "Host capability observation for process: NOT_ADMITTED."],
    ["DENIED", "Host capability observation for process: DENIED."],
  ] as const)("announces current host readiness without implying authority (%s)", (state, message) => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        consent={{ rightsAttested: false }}
        capabilities={state ? { process: state } : {}}
      />,
    );

    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain(message);
    expect(html).toContain("does not verify current voice rights or consent");
  });

  it("labels user attestation as an input rather than proof of current voice authority", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="approve"
        completedSteps={["process", "review"]}
        source={{ artifactId: "source-1", fileName: "source.wav" }}
        consent={{ rightsAttested: true, consentReference: "consent-1" }}
        capabilities={activeCapabilities}
        onApprove={vi.fn()}
      />,
    );

    expect(html).toContain("User assertion recorded; authority unverified");
    expect(html).toContain("This checkbox records a user assertion for review.");
    expect(html).toContain("does not verify current voice rights or consent");
  });
});
