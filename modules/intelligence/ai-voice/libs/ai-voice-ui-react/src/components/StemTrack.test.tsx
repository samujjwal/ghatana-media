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

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ] as const)("does not guess a volume control for %s", (_label, volume) => {
    const html = renderToStaticMarkup(
      <StemTrack
        stem={{ ...stem("vocals", "Vocals"), volume }}
        onVolumeChange={() => undefined}
        onPanChange={() => undefined}
      />,
    );

    expect(html).toContain("<output>Unavailable</output>");
    expect(html).not.toContain('aria-label="Vocals volume"');
    expect(html).toContain('aria-label="Vocals pan"');
    expect(html).not.toMatch(/(?:NaN|Infinity)/);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ] as const)("does not guess a pan control for %s", (_label, pan) => {
    const html = renderToStaticMarkup(
      <StemTrack
        stem={{ ...stem("vocals", "Vocals"), pan }}
        onVolumeChange={() => undefined}
        onPanChange={() => undefined}
      />,
    );

    expect(html).toContain("<output>Unavailable</output>");
    expect(html).toContain('aria-label="Vocals volume"');
    expect(html).not.toContain('aria-label="Vocals pan"');
    expect(html).not.toMatch(/(?:NaN|Infinity)/);
  });
});
