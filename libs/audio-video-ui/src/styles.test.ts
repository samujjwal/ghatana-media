import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MediaTaskFlow } from "./components/MediaTaskFlow";

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tokenAliases = readFileSync(resolve(repositoryRoot, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml"), "utf8");

describe("central Media UI treatment", () => {
  it("projects shared type and geometry tokens through one workflow root with density choices", () => {
    expect(styles).toContain("--media-font-body: var(--gh-semantic-typography-body-font-size)");
    expect(styles).toContain("--media-font-page-title: var(--gh-semantic-typography-page-title-font-size)");
    expect(styles).toContain("--media-space-standard: calc(var(--gh-semantic-geometry-gutter-standard) * 1px)");
    expect(styles).toContain('.media-task-flow[data-density="compact"]');
    expect(styles).toContain('.media-task-flow[data-density="comfortable"]');
    expect(styles).toContain("--media-interactive-target: calc(var(--gh-breakpoints-touch-targets-minimum) * 1px)");
  });

  it("keeps narrow layouts, themes, focus, reduced motion, and forced colors in the shared stylesheet", () => {
    expect(styles).toContain("container: media-task / inline-size");
    expect(styles).toContain("@container media-task (max-width: 48rem)");
    expect(styles).toContain("prefers-color-scheme: dark");
    expect(styles).toContain("data-color-scheme=\"dark\"");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).toContain("forced-colors: active");
    expect(styles).toContain(".media-screen-body fieldset");
    expect(styles).toContain("gap: var(--media-space-compact) var(--media-space-standard)");
    expect(styles).toContain("border-radius: .25rem");
    expect(styles).toContain("outline: 3px solid Highlight; outline-offset: 2px");
  });

  it("defines only CSS token aliases registered by the PDP-2 source", () => {
    const registered = new Set([...tokenAliases.matchAll(/^\s+cssVariable:\s*(--media-[a-z0-9-]+)\s*$/gmu)].map((match) => match[1]!));
    const locallyDefined = new Set([...styles.matchAll(/^\s*(--media-[a-z0-9-]+)\s*:/gmu)].map((match) => match[1]!));

    expect(locallyDefined.size).toBeGreaterThan(0);
    for (const variable of locallyDefined) expect(registered.has(variable), variable).toBe(true);
  });

  it("keeps disabled workflow-step text legible while preserving a visible disabled cue", () => {
    const disabledRule = /\.media-task-flow nav li > button:disabled\s*\{([^}]+)\}/u.exec(styles)?.[1] ?? "";

    expect(disabledRule).toContain("opacity: 1");
    expect(disabledRule).toContain("color: ButtonText");
    expect(disabledRule).toContain("background: ButtonFace");
    expect(disabledRule).toContain("border-style: dashed");
    expect(styles).toContain(".media-task-flow nav li > button:disabled > span:nth-child(3) { color: ButtonText; }");
    expect(styles).toContain('.media-task-flow nav li > button:disabled { color: ButtonText; background: ButtonFace; border-color: CanvasText; }');
  });

  it("retains the strict CSP control sheet without adding inline style or CSP bypasses", () => {
    expect(styles).toContain('@import "@ghatana/design-system/strict-csp-controls.css"');
    expect(styles).not.toMatch(/unsafe-inline|unsafe-eval/u);
    expect(styles).not.toMatch(/style\s*=/u);
  });

  it("exposes density and theme choices without changing unknown operation finality", () => {
    const html = renderToStaticMarkup(React.createElement(MediaTaskFlow, {
      density: "compact",
      colorScheme: "dark",
      currentProjection: {
        title: "Recover job",
        description: "Inspect the latest owner observation.",
        steps: [{ id: "inspect", title: "Inspect", description: "Check the existing job.", state: "current" }],
        currentStepId: "inspect",
      },
      operationObservation: {
        state: "UNKNOWN",
        progress: { kind: "unknown" },
        finality: "Still unknown; check before taking another action.",
      },
      children: React.createElement("p", null, "Job details"),
    }));

    expect(html).toContain('class="media-task-flow " data-density="compact" data-color-scheme="dark"');
    expect(html).toContain('role="status">The remote outcome is unknown. Check the operation status before taking another action.</p>');
    expect(html).toContain("Still unknown; check before taking another action.");
    expect(html).not.toContain("style=");
  });
});
