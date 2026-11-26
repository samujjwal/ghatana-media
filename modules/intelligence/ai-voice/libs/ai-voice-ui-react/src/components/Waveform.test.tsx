// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Waveform } from "./Waveform";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Waveform", () => {
  it("keeps finite playback position and duration semantics", () => {
    const html = renderToStaticMarkup(
      <Waveform data={[0.25, 0.5]} position={0.5} duration={120} onSeek={() => undefined} />,
    );

    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-valuetext="1:00 of 2:00"');
    expect(html).not.toMatch(/(?:NaN|Infinity)/);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ] as const)("does not expose a slider for %s playback position", (_label, position) => {
    const onSeek = vi.fn();
    const { container } = render(
      <Waveform data={[0.25, 0.5]} position={position} onSeek={onSeek} />,
    );
    const waveform = screen.getByRole("img", {
      name: "Audio waveform, playback position unavailable",
    });

    expect(screen.queryByRole("slider")).toBeNull();
    expect(waveform.textContent).toContain("Playback position unavailable");
    fireEvent.keyDown(waveform, { key: "ArrowRight" });
    fireEvent.click(waveform);
    expect(onSeek).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/(?:NaN|Infinity)/);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ] as const)("marks a waveform with %s samples unavailable without losing a valid seek position", (_label, sample) => {
    const { container } = render(
      <Waveform data={[0.25, sample]} position={0.5} onSeek={() => undefined} />,
    );
    const slider = screen.getByRole("slider", { name: "Audio waveform, waveform unavailable" });

    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    expect(container.textContent).toContain("Waveform unavailable");
    expect(container.textContent).not.toMatch(/(?:NaN|Infinity)/);
  });

  it("names unavailable waveform data when rendered as a noninteractive image", () => {
    const { container } = render(<Waveform data={[0.25, Number.NaN]} position={0.5} />);

    expect(
      screen.getByRole("img", {
        name: "Audio waveform, waveform unavailable, playback position 50 percent",
      }),
    ).toBeTruthy();
    expect(container.textContent).toContain("Waveform unavailable");
  });

  it("includes the empty-data state in the noninteractive accessible name", () => {
    render(<Waveform data={[]} position={0.5} />);

    expect(
      screen.getByRole("img", {
        name: "Audio waveform, no waveform data, playback position 50 percent",
      }),
    ).toBeTruthy();
  });

  it.each([
    ["a NaN playback position", { data: [0.25, 0.75], position: Number.NaN }],
    ["NaN waveform samples", { data: [0.25, Number.NaN], position: 0.5 }],
  ] as const)("does not pass non-finite coordinates for %s", (_label, props) => {
    const numericArguments: number[] = [];
    const recordNumbers = (...values: number[]): void => {
      numericArguments.push(...values);
    };
    const context = {
      setTransform: (...values: number[]) => recordNumbers(...values),
      clearRect: (...values: number[]) => recordNumbers(...values),
      fillRect: (...values: number[]) => recordNumbers(...values),
      beginPath: vi.fn(),
      moveTo: (...values: number[]) => recordNumbers(...values),
      lineTo: (...values: number[]) => recordNumbers(...values),
      rect: (...values: number[]) => recordNumbers(...values),
      clip: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 80,
      width: 100,
      height: 80,
      toJSON: () => ({}),
    } as DOMRect);

    render(<Waveform {...props} />);

    expect(numericArguments.length).toBeGreaterThan(0);
    expect(numericArguments.every(Number.isFinite)).toBe(true);
  });

  it("uses percentage value text when duration is non-finite", () => {
    const html = renderToStaticMarkup(
      <Waveform data={[0.25, 0.5]} position={0.5} duration={Number.POSITIVE_INFINITY} onSeek={() => undefined} />,
    );

    expect(html).toContain('aria-valuetext="50 percent"');
    expect(html).not.toContain("0:00 of 0:00");
    expect(html).not.toMatch(/(?:NaN|Infinity)/);
  });

  it("uses its default height when height is non-finite", () => {
    const html = renderToStaticMarkup(
      <Waveform data={[0.25, 0.5]} height={Number.POSITIVE_INFINITY} />,
    );

    expect(html).toContain("min-height:80px");
    expect(html).not.toMatch(/(?:NaN|Infinity)/);
  });

  it("does not pass a non-finite seek step to the callback", () => {
    const onSeek = vi.fn();
    render(<Waveform data={[0.25, 0.5]} position={0.5} seekStep={Number.NaN} onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: "Audio waveform" });

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.keyDown(slider, { key: "Home" });
    expect(onSeek).toHaveBeenCalledWith(0);
  });
});
