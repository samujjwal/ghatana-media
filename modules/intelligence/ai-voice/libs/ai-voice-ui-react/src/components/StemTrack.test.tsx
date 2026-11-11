import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StemTrack } from "./StemTrack";
import type { Stem } from "../types";

const stem = (type: Stem["type"], name: string): Stem => ({
  id: type,
  type,
  name,
  path: `${type}.wav`,
  duration: 12,
  volume: 0.75,
  pan: 0,
  muted: false,
  solo: false,
});

describe("StemTrack", () => {
  it("gives mixer sliders stem-specific accessible names", () => {
    const html = renderToStaticMarkup(
      <>
        <StemTrack stem={stem("vocals", "Vocals")} onVolumeChange={() => undefined} onPanChange={() => undefined} />
        <StemTrack stem={stem("drums", "Drums")} onVolumeChange={() => undefined} onPanChange={() => undefined} />
      </>,
    );

    expect(html).toContain('aria-label="Vocals volume"');
    expect(html).toContain('aria-label="Vocals pan"');
    expect(html).toContain('aria-label="Drums volume"');
    expect(html).toContain('aria-label="Drums pan"');
  });
});
