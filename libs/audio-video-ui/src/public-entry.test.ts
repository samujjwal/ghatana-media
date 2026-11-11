import { describe, expect, it } from "vitest";
import * as MediaUi from "./index";
import * as MediaUiComponents from "./components";
import type { MediaActionDispatchResult } from "./index";
import type { ArtifactUploadCapability } from "./screens";

describe("@audio-video/ui public root entry", () => {
  it("exposes the intended foundation, component, screen, port, hook, and player surfaces", () => {
    for (const exportName of [
      "Button",
      "MediaTaskFlow",
      "MediaProductRenderer",
      "useSpeechRecognition",
      "useSpeechSynthesis",
      "useMemoryPressure",
      "InteractiveDemoPlayer",
    ]) {
      expect(MediaUi).toHaveProperty(exportName);
    }
    expect(MediaUi).not.toHaveProperty("MediaActionFeedback");
    expect(MediaUi).not.toHaveProperty("mediaActionFeedbackForResult");
    expect(MediaUiComponents).not.toHaveProperty("MediaActionFeedback");
    expect(MediaUiComponents).not.toHaveProperty("mediaActionFeedbackForResult");
  });

  it("exports the product renderer contract exactly once through the root API", () => {
    expect(MediaUi.MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS).toBeDefined();
    expect(MediaUi.MediaProductRenderer).toBeTypeOf("function");
    const result: MediaActionDispatchResult = { status: "intent-accepted" };
    const uploadCapability: ArtifactUploadCapability | undefined = undefined;
    expect(result.status).toBe("intent-accepted");
    expect(uploadCapability).toBeUndefined();
  });
});
