import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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

    expect(html).toContain("rights attestation and a consent reference");
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
});
