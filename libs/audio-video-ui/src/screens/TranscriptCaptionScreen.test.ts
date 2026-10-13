import { describe, expect, it } from "vitest";
import { transcriptActionContext } from "./TranscriptCaptionScreen";

describe("transcript action context", () => {
  it("keeps host authorization subjects and binds exact transcript and caption versions", () => {
    const context = transcriptActionContext({
      id: "media.action.correct-caption",
      label: "Correct caption",
      enabled: true,
      subjectRefs: ["tenant:tenant-a", "source-version:source-v7"],
    }, ["source-version:source-v7", "transcript-version:transcript-v3", "caption-draft:draft-v2"]);

    expect(context.subjectRefs).toEqual([
      "tenant:tenant-a",
      "source-version:source-v7",
      "transcript-version:transcript-v3",
      "caption-draft:draft-v2",
    ]);
  });

  it("drops absent and blank version references without inventing an owner scope", () => {
    expect(transcriptActionContext(undefined, [undefined, "", "  ", "selected-version-v4"])).toEqual({
      subjectRefs: ["selected-version-v4"],
    });
  });
});
