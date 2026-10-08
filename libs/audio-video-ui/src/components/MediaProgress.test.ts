import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaProgress } from "./MediaProgress";

describe("MediaProgress", () => {
  it("renders determinate progress with bounded native semantics and no inline styles", () => {
    const html = renderToStaticMarkup(React.createElement(MediaProgress, {
      value: 120,
      max: 100,
      label: "Upload progress",
      valueText: "Complete",
      tone: "success",
    }));

    expect(html).toContain('<progress class="media-progress media-progress--success" max="100" value="100"');
    expect(html).toContain('aria-label="Upload progress"');
    expect(html).toContain('aria-valuetext="Complete"');
    expect(html).not.toContain(" style=");
  });

  it("preserves indeterminate progress as an omitted native value", () => {
    const html = renderToStaticMarkup(React.createElement(MediaProgress, { label: "Processing progress" }));

    expect(html).toContain('<progress class="media-progress media-progress--primary" max="100"');
    expect(html).toContain('aria-label="Processing progress"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(" value=");
    expect(html).not.toContain(" style=");
  });
});
