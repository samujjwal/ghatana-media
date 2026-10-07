#!/usr/bin/env node
/**
 * Purpose: exercise every Media Explorer/shared-candidate/CLI/Verify experience in a
 * real browser at the supported responsive viewports and emit deterministic
 * geometry/accessibility diagnostics plus review screenshots.
 * Consumers: local experience verification and the closure matrix.
 * Non-goals: human visual approval, WCAG certification, runtime/provider
 * qualification, or Tools-native acceptance.
 * Change policy: test the source-derived projection; never mutate product
 * authority or write Evidence Generator artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const auditConfig = Object.freeze({
  baseUrl: process.env.MEDIA_EXPLORER_URL ?? "http://127.0.0.1:4179/",
  artifactDirectory: resolve(process.env.MEDIA_EXPLORER_ARTIFACT_DIR ?? "/tmp/media-experience-browser-audit"),
});
export const viewports = Object.freeze([
  { name: "wide", width: 1536, height: 960 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "compact-desktop", width: 1024, height: 768 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow-mobile", width: 320, height: 640 },
]);
export const manualGates = Object.freeze({
  screenReader: { status: "MANUAL_NOT_VERIFIED", reason: "No supported screen-reader automation is configured for this audit." },
  independentVisualReview: { status: "MANUAL_NOT_VERIFIED", reason: "Screenshots and geometry diagnostics do not constitute independent expert visual review." },
  canonicalVisualReferences: { status: "NOT_SUPPLIED", reason: "No accepted canonical visual references are indexed for this browser audit." },
});

export function createAuditReport({ baseUrl, viewports: auditedViewports, scenarioCount = "unknown", productRouteCount = 0, observations = [], consoleErrors = [], pageErrors = [], failures = [], screenshots = [] }) {
  return {
    baseUrl,
    viewports: auditedViewports,
    coverage: ["retained viewport sweeps", "100% and 200% text sizing", "browser zoom/reflow", "keyboard", "forced colors", "reduced motion", "long-label localization stress", "RTL when admitted", "touch targets", "focus not obscured"],
    manualGates,
    scenarioCount,
    productRouteCount,
    observations,
    consoleErrors,
    pageErrors,
    failures,
    screenshots,
  };
}

export async function setTextScaleWithCdp(cdp, frameId, styleSheetId, scale, baselinePx) {
  try {
    if (!Number.isFinite(baselinePx) || baselinePx <= 0) throw new Error("computed baseline font size is unavailable");
    const sheetId = styleSheetId ?? (await cdp.send("CSS.createStyleSheet", { frameId })).styleSheetId;
    await cdp.send("CSS.setStyleSheetText", {
      styleSheetId: sheetId,
      text: `html { font-size: ${baselinePx * scale}px !important; }`,
    });
    return { supported: true, styleSheetId: sheetId };
  } catch (error) {
    return { supported: false, styleSheetId: styleSheetId ?? null, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function classifyTouchTarget(target) {
  if (target.disabled) return { include: false, reason: "disabled" };
  if (target.hidden || target.inert || target.ariaHidden || !target.rendered || target.display === "none" || target.visibility === "hidden") {
    return { include: false, reason: "hidden or not rendered" };
  }
  if (target.opacity === "0" && target.delegatedVisibleLabel) {
    return { include: false, reason: "visually-hidden control represented by its visible label" };
  }
  return { include: true, reason: "enabled visible target" };
}

const artifacts = (await import("../apps/media-experience-explorer/specification-artifacts.json", { with: { type: "json" } })).default;
const productRoutes = artifacts
  .filter(({ path }) => path.includes("/pdp-3-product-experience/screen-contracts/") && !path.endsWith("/artifact-verification-job-family.yaml"))
  .map(({ path }) => path);
const artifactVerificationSpecialization = artifacts.find(({ path }) => path.endsWith("/artifact-verification-job-family.yaml"))?.path;

async function runAudit() {
const { baseUrl, artifactDirectory } = auditConfig;
const failures = [];
const observations = [];

function fail(scope, message) {
  failures.push({ scope, message });
}

async function inspectPage(page, scope, { requireMain = true, requireNoHorizontalOverflow = true } = {}) {
  const result = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const accessibleName = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria?.trim()) return aria.trim();
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const value = labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (value) return value;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const label = element.labels?.[0]?.textContent?.trim();
        if (label) return label;
      }
      return element.textContent?.trim() ?? "";
    };
    const body = document.body;
    const documentElement = document.documentElement;
    const unnamed = [...document.querySelectorAll("button, a, input, textarea, select, [role=tab], [role=radio]")]
      .filter(visible)
      .filter((element) => !accessibleName(element))
      .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`);
    const visibleProposalActions = [...document.querySelectorAll(".product-proposal-action-list button")]
      .filter(visible)
      .map((element) => ({ text: element.textContent?.trim() ?? "", disabled: element.disabled }));
    const rects = [...document.querySelectorAll("main, header, aside, section, .product-app, .explorer-shell, #explorer-panel")]
      .filter(visible)
      .map((element) => ({
        selector: element.id ? `#${element.id}` : element.className?.toString().split(/\s+/u).filter(Boolean)[0] ?? element.tagName.toLowerCase(),
        left: Math.round(element.getBoundingClientRect().left * 100) / 100,
        right: Math.round(element.getBoundingClientRect().right * 100) / 100,
        width: Math.round(element.getBoundingClientRect().width * 100) / 100,
      }));
    return {
      title: document.title,
      h1: [...document.querySelectorAll("h1")].filter(visible).map((element) => element.textContent?.trim() ?? ""),
      mainCount: document.querySelectorAll("main").length,
      innerWidth: window.innerWidth,
      clientWidth: documentElement.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      documentScrollWidth: documentElement.scrollWidth,
      unnamed,
      visibleProposalActions,
      rects,
    };
  });

  if (requireMain && result.mainCount < 1) fail(scope, "no visible main landmark");
  if (!result.title) fail(scope, "document title is empty");
  if (!result.h1.length) fail(scope, "no visible h1");
  if (requireNoHorizontalOverflow && (result.bodyScrollWidth > result.clientWidth || result.documentScrollWidth > result.clientWidth)) {
    fail(scope, `horizontal overflow: body=${result.bodyScrollWidth}, document=${result.documentScrollWidth}, client=${result.clientWidth}`);
  }
  if (result.unnamed.length) fail(scope, `visible controls without accessible names: ${result.unnamed.join(", ")}`);
  for (const action of result.visibleProposalActions) {
    if (!action.disabled) fail(scope, `proposal action is enabled: ${action.text}`);
  }
  return result;
}

async function gotoHash(page, hash) {
  await page.goto(`${baseUrl.replace(/\/$/u, "")}/${hash}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(30);
}

async function screenshot(page, name) {
  await page.screenshot({ path: resolve(artifactDirectory, `${name}.png`), fullPage: false });
}

await mkdir(artifactDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ reducedMotion: "reduce", colorScheme: "light", locale: "en-US" });
const page = await context.newPage({ viewport: viewports[1] });
const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await gotoHash(page, "#explore");
  const scenarioIds = await page.locator("#scenario-picker option").evaluateAll((options) => options.map((option) => option.value));
  observations.push(`explore scenarios: ${scenarioIds.length}`);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const scenarioId of scenarioIds) {
      await page.selectOption("#scenario-picker", scenarioId);
      const result = await inspectPage(page, `explore/${scenarioId}/${viewport.name}`);
      if (!result.title.includes("Media Experience Explorer")) fail(`explore/${scenarioId}/${viewport.name}`, `unexpected title: ${result.title}`);
    }
  }

  await gotoHash(page, "#explore");
  await page.locator("#mode-explore").focus();
  const modes = await page.locator('[role="tab"][data-mode]').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.mode));
  const exploreIndex = modes.indexOf("explore");
  const nextMode = modes[(exploreIndex + 1) % modes.length];
  await page.keyboard.press("ArrowRight");
  if (await page.locator(`#mode-${nextMode}`).getAttribute("aria-selected") !== "true") fail("keyboard/mode-tabs", `ArrowRight did not select ${nextMode}`);
  await page.locator(`#mode-${nextMode}`).focus();
  await page.keyboard.press("Enter");
  await inspectPage(page, `keyboard/${nextMode}`);
  await page.locator("#phase-tab-pdp-0").focus();
  await page.keyboard.press("ArrowDown");
  if (await page.locator("#phase-tab-pdp-1").getAttribute("aria-checked") !== "true") fail("keyboard/phase-tabs", "ArrowDown did not select PDP-1");
  observations.push("keyboard mode-tab and phase-radio navigation exercised");

  // Focused proof that the review-only route invokes the existing Media Tools
  // consumer and preserves its deliberately local, non-acceptance scope.
  const toolsReviewConsoleErrorStart = consoleErrors.length;
  const toolsReviewPageErrorStart = pageErrors.length;
  await gotoHash(page, "#tools-review");
  await page.getByRole("heading", { name: "Package render, inspection, and dispatch" }).waitFor({ state: "visible", timeout: 10000 });
  const toolsReviewText = await page.locator("#explorer-panel").innerText();
  for (const expected of [
    "LOCAL SNAPSHOT SIMULATION PROOF",
    "media.experience.simulation",
    "Lifecycle currentness\nAbsent",
    "Owner acceptance\nNone",
  ]) {
    if (!toolsReviewText.includes(expected)) fail("tools-review", `consumer proof text is missing: ${expected}`);
  }
  if (consoleErrors.length !== toolsReviewConsoleErrorStart) fail("tools-review", `console errors: ${consoleErrors.slice(toolsReviewConsoleErrorStart).join(" | ")}`);
  if (pageErrors.length !== toolsReviewPageErrorStart) fail("tools-review", `page errors: ${pageErrors.slice(toolsReviewPageErrorStart).join(" | ")}`);
  observations.push("Tools Review route loaded the Media consumer result with local snapshot proof, absent currentness, no owner acceptance, and no route-specific browser errors");

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await gotoHash(page, "#specification");
    const phaseIds = await page.locator("button[role=radio][data-phase]").evaluateAll((buttons) => buttons.map((button) => button.dataset.phase));
    for (const phase of phaseIds) {
      await page.locator(`button[role=radio][data-phase="${phase}"]`).click();
      const phaseResult = await inspectPage(page, `specification/${phase}/${viewport.name}`);
      const countText = await page.locator("#artifact-count").textContent();
      if (!countText?.includes("of")) fail(`specification/${phase}/${viewport.name}`, "artifact count is missing");
      if (!phaseResult.rects.some(({ selector }) => selector === "spec-document" || selector === "spec-inspector")) fail(`specification/${phase}/${viewport.name}`, "specification content geometry is missing");
    }
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHash(page, "#specification");
  const phaseButtons = await page.locator("button[role=radio][data-phase]").evaluateAll((buttons) => buttons.map((button) => button.dataset.phase));
  let artifactCount = 0;
  for (const phase of phaseButtons) {
    await page.locator(`button[role=radio][data-phase="${phase}"]`).click();
    const artifactPaths = await page.locator("button[data-artifact]").evaluateAll((buttons) => buttons.map((button) => button.dataset.artifact));
    for (const artifactPath of artifactPaths) {
      await page.locator("button[data-artifact]").evaluateAll((buttons, path) => {
        buttons.find((button) => button.dataset.artifact === path)?.click();
      }, artifactPath);
      await page.waitForTimeout(10);
      const trace = await page.locator(".trace-metadata").count();
      if (trace !== 1) fail(`specification/artifact/${artifactPath}`, "source trace metadata is missing");
      artifactCount += 1;
    }
  }
  observations.push(`specification artifacts exercised: ${artifactCount}`);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await gotoHash(page, "#verify");
    const verifyResult = await inspectPage(page, `verify/${viewport.name}`);
    if (verifyResult.h1[0] !== "Verify experience") fail(`verify/${viewport.name}`, "unexpected Verify heading");
    if (await page.getByText("NOT SUPPLIED", { exact: true }).count() < 1 || !(await page.getByText("No durable run report is indexed", { exact: false }).count())) {
      fail(`verify/${viewport.name}`, "Verify no longer reports results not supplied / no durable indexed run report");
    }
  }

  let routeCount = 0;
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of productRoutes) {
      await gotoHash(page, `#product/view/${encodeURIComponent(route)}`);
      await page.locator(".view-contract-preview").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      const result = await inspectPage(page, `legacy-proposal/${route}/${viewport.name}`, { requireMain: true, requireNoHorizontalOverflow: true });
      if (await page.locator("#app").getAttribute("data-mode") !== "specification") fail(`legacy-proposal/${route}/${viewport.name}`, "legacy proposal URL did not resolve to Specification mode");
      if (await page.locator(".view-contract-preview").count() !== 1) fail(`legacy-proposal/${route}/${viewport.name}`, "read-only Specification proposal preview is missing");
      if (await page.locator("#shared-presentation-mount").count()) fail(`legacy-proposal/${route}/${viewport.name}`, "legacy proposal route mounted a Product presentation");
      if (result.h1[0] !== "Specification") fail(`legacy-proposal/${route}/${viewport.name}`, "proposal route is not headed as Specification");
      routeCount += 1;
    }
  }
  observations.push(`Legacy proposal URLs exercised in read-only Specification mode: ${routeCount}`);

  const candidateScenarios = [
    { id: "media.scenario.first-use-empty", heading: "Projects in this workspace" },
    { id: "media.scenario.upload-interrupted", heading: "Import media" },
    { id: "media.scenario.artifact-verification-running", heading: "Job status and recovery" },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const candidate of candidateScenarios) {
      await gotoHash(page, "#explore");
      await page.selectOption("#scenario-picker", candidate.id);
      await page.locator('.preview-toolbar button[data-mode="product"]').click();
      const scope = `candidate/${candidate.id}/${viewport.name}`;
      await inspectPage(page, scope);
      if (await page.locator("#app").getAttribute("data-mode") !== "product") fail(scope, "candidate review mount is not in Product review mode");
      if (!(await page.getByText("CANDIDATE · NOT ADMITTED", { exact: true }).count())) fail(scope, "candidate admission status is not visible");
      if (await page.locator("#shared-presentation-mount .media-screen-body").count() !== 1) fail(scope, "shared screen body did not mount");
      if (!(await page.locator("#shared-presentation-mount").getByText(candidate.heading, { exact: true }).count())) fail(scope, `unexpected candidate heading; expected ${candidate.heading}`);
    }
    await gotoHash(page, "#explore");
    await page.selectOption("#scenario-picker", "media.scenario.caption-corrected");
    await page.locator('.preview-toolbar button[data-mode="product"]').click();
    await page.locator('button[data-workflow-view="captions"]').click();
    const captionScope = `candidate/media.scenario.caption-corrected/captions/${viewport.name}`;
    if (await page.locator("#shared-presentation-mount .media-screen-body").count() !== 1) fail(captionScope, "transcript/caption shared screen body did not mount");
    if (!(await page.locator("#shared-presentation-mount").getByText("Correct captions", { exact: true }).count())) fail(captionScope, "transcript/caption candidate screen did not render");
    const captionInput = page.locator("#shared-presentation-mount textarea").first();
    if (await captionInput.count()) {
      await captionInput.fill("Browser review caption draft");
      const applyCorrection = page.locator("#shared-presentation-mount button", { hasText: "Apply caption correction" }).first();
      if (await applyCorrection.isEnabled()) {
        await applyCorrection.click();
        if (await captionInput.inputValue() !== "Browser review caption draft") fail(captionScope, "caption correction payload was not retained by the simulation adapter");
      } else fail(captionScope, "source fixture did not expose its declared caption-correction action");
    } else fail(captionScope, "caption draft editor is missing");
  }
  observations.push("J-01, J-02, J-20 and J-03 shared candidate bodies mounted at all six viewports; caption correction payload exercised");

  // Text sizing and zoom/reflow checks are intentionally separate: CSS text
  // scaling and Chromium page-scale zoom exercise different failure modes.
  const cdp = await context.newCDPSession(page);
  let textScaleSheetId = null;
  let textScaleBaselinePx = null;
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const frameTree = await cdp.send("Page.getFrameTree");
    const frameId = frameTree.frameTree.frame.id;
    textScaleBaselinePx = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
    for (const scale of [1, 2]) {
    await gotoHash(page, "#explore");
      const injection = await setTextScaleWithCdp(cdp, frameId, textScaleSheetId, scale, textScaleBaselinePx);
      if (!injection.supported) {
        const message = `UNSUPPORTED_NOT_VERIFIED: CDP stylesheet injection for ${scale * 100}% text sizing failed: ${injection.reason}`;
        observations.push(message);
        fail(`text-size/${scale * 100}%`, message);
        continue;
      }
      textScaleSheetId = injection.styleSheetId;
      await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
      const actualRootFontSizePx = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
      const expectedRootFontSizePx = textScaleBaselinePx * scale;
      if (!Number.isFinite(actualRootFontSizePx) || Math.abs(actualRootFontSizePx - expectedRootFontSizePx) > 0.5) {
        const message = `UNSUPPORTED_NOT_VERIFIED: requested ${scale * 100}% root text size, computed ${actualRootFontSizePx}px; expected ${expectedRootFontSizePx}px`;
        observations.push(message);
        fail(`text-size/${scale * 100}%`, message);
        continue;
      }
    const result = await inspectPage(page, `text-size/${scale * 100}%`);
    if (result.bodyScrollWidth > result.clientWidth) fail(`text-size/${scale * 100}%`, "horizontal reflow failure at text scale");
      observations.push(`text sizing ${scale * 100}%: SUPPORTED_AND_EXERCISED (computed root font size ${actualRootFontSizePx}px)`);
    }
  } catch (error) {
    const message = `UNSUPPORTED_NOT_VERIFIED: text scaling audit setup failed: ${error instanceof Error ? error.message : String(error)}`;
    observations.push(message);
    fail("text-size/setup", message);
  } finally {
    if (textScaleSheetId) {
      try { await cdp.send("CSS.setStyleSheetText", { styleSheetId: textScaleSheetId, text: "" }); } catch { /* The page is closing; report remains authoritative. */ }
    }
  }
  await gotoHash(page, "#explore");
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await inspectPage(page, "browser-zoom/200%", { requireNoHorizontalOverflow: false });
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await page.setViewportSize({ width: 640, height: 800 }); // 200% desktop zoom equivalent layout viewport.
  await inspectPage(page, "browser-zoom/reflow-equivalent-640px");
  observations.push("browser zoom: Chromium page scale 200% and equivalent narrow layout viewport exercised");

  await gotoHash(page, "#explore");
  await page.emulateMedia({ forcedColors: "active" });
  await inspectPage(page, "forced-colors/active");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  await inspectPage(page, "reduced-motion/reduce");
  observations.push("forced-colors active and reduced-motion reduce preferences exercised");

  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoHash(page, "#explore");
  const longLabelAudit = await page.locator('[role="tab"][data-mode]').evaluateAll((tabs) => {
    const originals = tabs.map((tab) => ({ tab, markup: tab.innerHTML }));
    for (const { tab } of originals) tab.append(document.createTextNode(" — Übersetzte Bezeichnung mit zusätzlichem erklärendem Text"));
    const result = originals.map(({ tab }) => ({
      label: tab.textContent?.trim() ?? "",
      width: tab.getBoundingClientRect().width,
      scrollWidth: tab.scrollWidth,
      clientWidth: tab.clientWidth,
    }));
    for (const { tab, markup } of originals) tab.innerHTML = markup;
    return result;
  });
  for (const label of longLabelAudit.filter(({ scrollWidth, clientWidth }) => scrollWidth > clientWidth + 1)) {
    fail("long-label-localization", `expanded label overflows its mode tab (${label.scrollWidth}px > ${label.clientWidth}px)`);
  }
  observations.push(`long-label localization stress: ${longLabelAudit.length} mode labels expanded with a deterministic long-label fixture (not a translation claim)`);
  const rtlAdmitted = await page.locator("html[data-rtl-supported='true'], [data-rtl-supported='true']").count() > 0;
  if (rtlAdmitted) {
    await page.evaluate(() => { document.documentElement.dir = "rtl"; });
    await inspectPage(page, "rtl/admitted");
    observations.push("RTL: exercised because the rendered surface declares data-rtl-supported=true");
  } else observations.push("RTL: not admitted by rendered surface; not simulated");
  const touchTargetCandidates = await page.locator("button, a, input, select, textarea, [role=tab], [role=radio], label.toggle-row").evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const delegatedLabel = node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type) ? node.closest("label") : null;
    const delegatedStyle = delegatedLabel ? getComputedStyle(delegatedLabel) : null;
    const delegatedRect = delegatedLabel?.getBoundingClientRect();
    const delegatedVisibleLabel = Boolean(delegatedLabel && delegatedLabel.getClientRects().length && delegatedStyle?.display !== "none" && delegatedStyle?.visibility === "visible" && delegatedStyle.opacity !== "0" && delegatedRect && delegatedRect.width >= 24 && delegatedRect.height >= 24);
    return {
      name: (node.getAttribute("aria-label") || node.textContent || node.tagName).trim().slice(0, 80),
      tagName: node.tagName,
      disabled: node.matches(":disabled"),
      hidden: node.hidden || Boolean(node.closest("[hidden]")),
      inert: Boolean(node.closest("[inert]")),
      ariaHidden: node.closest('[aria-hidden="true"]') !== null,
      rendered: node.getClientRects().length > 0,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      delegatedVisibleLabel,
      width: rect.width,
      height: rect.height,
      delegatedLabelSize: delegatedRect ? { width: delegatedRect.width, height: delegatedRect.height } : null,
    };
  }));
  const touchTargets = touchTargetCandidates.filter((target) => classifyTouchTarget(target).include);
  const excludedTouchTargets = touchTargetCandidates.filter((target) => !classifyTouchTarget(target).include);
  for (const target of touchTargets.filter(({ width, height }) => width < 24 || height < 24)) fail("touch-targets", `target below 24 CSS px: ${target.name} (${target.width}x${target.height})`);
  const representedHiddenControls = excludedTouchTargets.filter(({ delegatedVisibleLabel }) => delegatedVisibleLabel);
  observations.push(`touch targets: ${touchTargets.length} enabled visible targets checked against 24 CSS px; ${representedHiddenControls.length} visually-hidden checkbox/radio controls represented by visible associated labels; ${excludedTouchTargets.length - representedHiddenControls.length} disabled/hidden/non-rendered targets excluded`);

  await gotoHash(page, "#explore");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  await page.keyboard.press("Tab");
  const focusState = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return { focused: false, inViewport: false, obscured: true };
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    const target = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${element.className?.toString().split(/\s+/u).filter(Boolean).join(".") ?? ""}`;
    return { focused: true, target, scrollX: window.scrollX, scrollY: window.scrollY, rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth, obscured: !hit || !(hit === element || element.contains(hit) || hit.contains(element)) };
  });
  if (!focusState.focused || !focusState.inViewport || focusState.obscured) fail("focus-not-obscured", `focused element visibility check failed: ${JSON.stringify(focusState)}`);
  observations.push("focus-not-obscured: first keyboard focus target checked for viewport visibility and hit-test obstruction");
  if (artifactVerificationSpecialization) {
    await gotoHash(page, `#product/view/${encodeURIComponent(artifactVerificationSpecialization)}`);
    if (await page.locator("#app").getAttribute("data-mode") !== "specification") fail("legacy/artifact-verification-specialization", "non-screen proposal did not stay in Specification mode");
    if (!(await page.getByText("Legacy Product URL opened as Specification", { exact: true }).count())) fail("legacy/artifact-verification-specialization", "legacy non-screen proposal URL did not show a Specification-only notice");
    if (await page.locator("#shared-presentation-mount").count()) fail("legacy/artifact-verification-specialization", "non-screen proposal mounted a Product composition");
    observations.push("Artifact-verification job-family URL remains a Specification record, not a Product route");
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHash(page, "#explore");
  await screenshot(page, "explore-desktop");
  await gotoHash(page, "#specification");
  await screenshot(page, "specification-desktop");
  await gotoHash(page, "#verify");
  await screenshot(page, "verify-desktop");
  await gotoHash(page, "#product");
  await page.locator('button[data-workflow-view="captions"]').click();
  await screenshot(page, "candidate-edit-captions-desktop");
  await page.setViewportSize({ width: 320, height: 640 });
  await gotoHash(page, "#explore");
  await screenshot(page, "explore-narrow-mobile");
  await gotoHash(page, "#specification");
  await screenshot(page, "specification-narrow-mobile");
  await gotoHash(page, "#verify");
  await screenshot(page, "verify-narrow-mobile");
  await gotoHash(page, "#product");
  await page.locator('button[data-workflow-view="captions"]').click();
  await screenshot(page, "candidate-edit-captions-narrow-mobile");
} finally {
  await context.close();
  await browser.close();
}

const report = createAuditReport({
  baseUrl,
  viewports,
  scenarioCount: observations.find((item) => item.startsWith("explore scenarios:")) ?? "unknown",
  productRouteCount: productRoutes.length,
  observations,
  consoleErrors,
  pageErrors,
  failures,
  screenshots: [
    "explore-desktop.png", "specification-desktop.png", "verify-desktop.png", "candidate-edit-captions-desktop.png",
    "explore-narrow-mobile.png", "specification-narrow-mobile.png", "verify-narrow-mobile.png", "candidate-edit-captions-narrow-mobile.png",
  ].map((name) => resolve(artifactDirectory, name)),
});
await writeFile(resolve(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (consoleErrors.length || pageErrors.length || failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAudit();
