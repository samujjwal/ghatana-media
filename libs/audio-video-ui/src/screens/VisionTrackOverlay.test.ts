// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VisionTrackOverlay } from "./VisionTrackOverlay";
import { parseVisionTracksDocument } from "./devVisionTracks";
import { sampleDocument } from "./visionTracksFixture";

afterEach(cleanup);

const doc = parseVisionTracksDocument(sampleDocument());

function renderOverlay(): { video: HTMLVideoElement; setTime: (seconds: number, event?: string) => void } {
  render(React.createElement(VisionTrackOverlay, { document: doc, videoSrc: "blob:fixture/video", videoLabel: "Source video src-1 with tracked object boxes" }));
  const video = document.querySelector("video")!;
  let current = 0;
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => current, set: (value: number) => { current = value; } });
  const setTime = (seconds: number, event = "timeupdate"): void => {
    current = seconds;
    act(() => { video.dispatchEvent(new Event(event)); });
  };
  return { video, setTime };
}

const overlay = (): SVGSVGElement => document.querySelector("svg.vto-overlay")!;
const boxIds = (): string[] => [...overlay().querySelectorAll("g[data-track-id]")].map((node) => node.getAttribute("data-track-id")!);

describe("VisionTrackOverlay", () => {
  it("draws exact boxes in source pixels on each sampled frame", () => {
    const { setTime } = renderOverlay();
    // The first sampled frame is at PTS 0, so the initial playhead is already on it.
    expect(overlay().getAttribute("viewBox")).toBe("0 0 640 360");
    expect(overlay().getAttribute("data-frame-index")).toBe("0");
    expect(boxIds()).toEqual(["T0001"]);
    const rect = overlay().querySelector("g[data-track-id='T0001'] rect")!;
    expect(rect.getAttribute("x")).toBe("20");
    expect(rect.getAttribute("y")).toBe("250");
    expect(rect.getAttribute("width")).toBe("160");
    expect(rect.getAttribute("height")).toBe("77");

    setTime(0.3);
    expect(overlay().getAttribute("data-frame-index")).toBe("3");
    expect(overlay().getAttribute("data-sync")).toBe("exact");
    expect(boxIds()).toEqual(["T0001", "T0002"]);
    expect(overlay().querySelector("g[data-track-id='T0001'] rect")!.getAttribute("x")).toBe("47");
    expect(overlay().querySelector("g[data-track-id='T0002'] rect")!.getAttribute("y")).toBe("55");
  });

  it("follows the playhead PTS and says when an earlier sampled frame is only held", () => {
    const { setTime } = renderOverlay();
    setTime(0.45);
    expect(overlay().getAttribute("data-frame-index")).toBe("3");
    expect(overlay().getAttribute("data-sync")).toBe("held");
    setTime(0.6);
    expect(overlay().getAttribute("data-frame-index")).toBe("6");
    expect(overlay().getAttribute("data-sync")).toBe("exact");
    expect(overlay().querySelector("g[data-track-id='T0001'] rect")!.getAttribute("x")).toBe("74");
    setTime(0.1);
    expect(overlay().getAttribute("data-frame-index")).toBe("0");
    expect(overlay().getAttribute("data-sync")).toBe("held");
    expect(boxIds()).toEqual(["T0001"]);
  });

  it("is accessible: labelled video, labelled box group, titles, polite status updated on seek, keyboard list", () => {
    const { setTime, video } = renderOverlay();
    expect(video.getAttribute("aria-label")).toBe("Source video src-1 with tracked object boxes");
    expect(video.hasAttribute("controls")).toBe(true);
    setTime(0.3);
    expect(screen.getByRole("group", { name: "Tracked object boxes at 0.300 s" })).toBe(overlay());
    expect(overlay().querySelector("g[data-track-id='T0002'] title")!.textContent).toContain("person T0002: box x 500, y 55, width 68, height 151 source pixels at 0.300 s");
    // Every box's decorative text is hidden from assistive tech; its <title> carries the accessible name.
    expect(overlay().querySelector("text")!.getAttribute("aria-hidden")).toBe("true");

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    // timeupdate (playing) does not announce; a completed seek does.
    expect(status.textContent).not.toContain("0.300 s");
    setTime(0.3, "seeked");
    expect(status.textContent).toContain("At 0.300 s: 2 tracked objects from sampled frame 3 at 0.300 s: car T0001, person T0002.");
    setTime(0.45, "pause");
    expect(status.textContent).toContain("held from the earlier sampled frame");

    const list = screen.getByRole("list", { name: "Tracks" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("T0001 · car");
    expect(items[0]!.textContent).toContain("3 observations, 0.000 s to 0.600 s");
    expect(items[1]!.textContent).toContain("2 observations, 0.300 s to 0.600 s");
    expect(items[1]!.getAttribute("data-visible")).toBe("true");
    setTime(0.0);
    expect(items[1]!.getAttribute("data-visible")).toBe("false");
    expect(items[1]!.textContent).toContain("not in the current frame");
    expect(document.querySelectorAll("[style]").length).toBe(0);
  });

  it("selects a track from the list and dims the others, toggling back", () => {
    const { setTime } = renderOverlay();
    setTime(0.3);
    const pick = screen.getByRole("button", { name: "T0002 · person" });
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    expect(overlay().querySelector("g[data-track-id='T0002']")!.getAttribute("class")).toContain("is-selected");
    expect(overlay().querySelector("g[data-track-id='T0001']")!.getAttribute("class")).toContain("is-dimmed");
    fireEvent.click(pick);
    expect(overlay().querySelector("g[data-track-id='T0001']")!.getAttribute("class")).not.toContain("is-dimmed");
  });

  it("seeks the video to a track's first observation and can hide the boxes", () => {
    const { video, setTime } = renderOverlay();
    setTime(0);
    fireEvent.click(screen.getByRole("button", { name: "Seek to the first observation of person T0002" }));
    expect(video.currentTime).toBeCloseTo(0.301, 3);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show boxes on the video" }));
    expect(document.querySelector("svg.vto-overlay")).toBeNull();
  });
});
