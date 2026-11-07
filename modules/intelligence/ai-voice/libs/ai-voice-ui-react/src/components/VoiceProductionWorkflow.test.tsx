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

  it("blocks approval until rights attestation and consent identity are present", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="approve"
        completedSteps={["process", "review"]}
        source={{ artifactId: "source-1", fileName: "source.wav" }}
        consent={{ rightsAttested: false }}
        capabilities={activeCapabilities}
        onApprove={vi.fn()}
      />,
    );

    expect(html).toContain("user rights assertion and a consent reference");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Approve output");
  });

  it("enables governed export only after approval", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="export"
        completedSteps={["process", "review", "approve"]}
        source={{ artifactId: "source-1", fileName: "source.wav" }}
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
    expect(html).not.toContain("Approve the output before export");
  });

  it("explains runtime capability blockers instead of hiding the step", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ artifactId: "source-1", fileName: "source.wav" }}
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

  it("fails closed when no current capability observation is supplied", () => {
    const html = renderToStaticMarkup(
      <VoiceProductionWorkflow
        projectName="Voice campaign"
        currentStep="process"
        source={{ artifactId: "source-1", fileName: "source.wav" }}
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
