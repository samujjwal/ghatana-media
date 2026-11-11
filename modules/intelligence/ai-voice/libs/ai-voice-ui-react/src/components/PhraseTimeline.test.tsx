import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PhraseTimeline } from "./PhraseTimeline";

vi.mock("./useSemanticColors", () => ({
  useSemanticColors: () => ({
    content: "#111111",
    contentSecondary: "#333333",
    border: "#555555",
    focus: "#005fcc",
    surface: "#ffffff",
    surfaceElevated: "#f5f5f5",
  }),
}));

describe("PhraseTimeline", () => {
  it("keeps unselected phrase buttons visibly focusable for keyboard users", () => {
    const html = renderToStaticMarkup(
      <PhraseTimeline
        duration={20}
        phrases={[
          { id: "phrase-a", startTime: 0, endTime: 5, text: "First" },
          { id: "phrase-b", startTime: 5, endTime: 10, text: "Second" },
        ]}
        onPhraseClick={() => undefined}
      />,
    );
    const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map((match) => match[1]);

    expect(buttons).toHaveLength(2);
    for (const attributes of buttons) {
      expect(attributes).toContain("focus-visible:ring-2");
      expect(attributes).toContain("focus-visible:ring-offset-2");
      expect(attributes).toContain("--tw-ring-color:");
    }
  });
});
