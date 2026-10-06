#!/usr/bin/env node
/**
 * Purpose: exercise every Media Explorer/Product/CLI/Verify experience in a
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
import { chromium } from "playwright";

const baseUrl = process.env.MEDIA_EXPLORER_URL ?? "http://127.0.0.1:4179/";
const artifactDirectory = resolve(process.env.MEDIA_EXPLORER_ARTIFACT_DIR ?? "/tmp/media-experience-browser-audit");
const viewports = [
  { name: "wide", width: 1536, height: 960 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "compact-desktop", width: 1024, height: 768 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow-mobile", width: 320, height: 640 },
];

const artifacts = (await import("../apps/media-experience-explorer/specification-artifacts.json", { with: { type: "json" } })).default;
const productRoutes = artifacts
  .filter(({ path }) => path.includes("/phase-2-product-experience/screen-contracts/") && !path.endsWith("/artifact-verification-job-family.yaml"))
  .map(({ path }) => path);
const artifactVerificationSpecialization = artifacts.find(({ path }) => path.endsWith("/artifact-verification-job-family.yaml"))?.path;

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
  await page.keyboard.press("ArrowRight");
  if (await page.locator("#mode-specification").getAttribute("aria-selected") !== "true") fail("keyboard/mode-tabs", "ArrowRight did not select Specification");
  await page.locator("#mode-specification").focus();
  await page.keyboard.press("Enter");
  await inspectPage(page, "keyboard/specification");
  await page.locator("#phase-tab-p0").focus();
  await page.keyboard.press("ArrowDown");
  if (await page.locator("#phase-tab-p1").getAttribute("aria-checked") !== "true") fail("keyboard/phase-tabs", "ArrowDown did not select P1");
  observations.push("keyboard mode-tab and phase-radio navigation: pass");

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
    if (await page.locator(".phase-status-card").count() !== 4) fail(`verify/${viewport.name}`, "expected four phase status cards");
    if (verifyResult.h1[0] !== "Verify experience") fail(`verify/${viewport.name}`, "unexpected Verify heading");
  }

  let routeCount = 0;
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of productRoutes) {
      await gotoHash(page, `#product/view/${encodeURIComponent(route)}`);
      const result = await inspectPage(page, `product/${route}/${viewport.name}`, { requireMain: true, requireNoHorizontalOverflow: true });
      if (await page.locator(".product-proposal-action-list button:not([disabled])").count()) fail(`product/${route}/${viewport.name}`, "proposal action enabled");
      if (!result.h1[0]) fail(`product/${route}/${viewport.name}`, "product proposal title is missing");
      routeCount += 1;
    }
  }
  observations.push(`Product proposal routes exercised: ${routeCount}`);
  if (artifactVerificationSpecialization) {
    await gotoHash(page, `#product/view/${encodeURIComponent(artifactVerificationSpecialization)}`);
    const specializationHeading = await page.locator("h1").first().textContent();
    if (specializationHeading !== "View proposal not found") fail("product/artifact-verification-specialization", "non-screen job-family specialization became an executable Product route");
    observations.push("artifact-verification job-family specialization remains inline/non-route: pass");
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHash(page, "#explore");
  await screenshot(page, "explore-desktop");
  await gotoHash(page, "#specification");
  await screenshot(page, "specification-desktop");
  await gotoHash(page, "#verify");
  await screenshot(page, "verify-desktop");
  await gotoHash(page, `#product/view/${encodeURIComponent(productRoutes.find((route) => route.endsWith("edit-captions.yaml")) ?? productRoutes[0])}`);
  await screenshot(page, "product-edit-captions-desktop");
  await page.setViewportSize({ width: 320, height: 640 });
  await gotoHash(page, "#explore");
  await screenshot(page, "explore-narrow-mobile");
  await gotoHash(page, "#specification");
  await screenshot(page, "specification-narrow-mobile");
  await gotoHash(page, "#verify");
  await screenshot(page, "verify-narrow-mobile");
  await gotoHash(page, `#product/view/${encodeURIComponent(productRoutes.find((route) => route.endsWith("edit-captions.yaml")) ?? productRoutes[0])}`);
  await screenshot(page, "product-edit-captions-narrow-mobile");
} finally {
  await context.close();
  await browser.close();
}

const report = {
  baseUrl,
  viewports,
  scenarioCount: observations.find((item) => item.startsWith("explore scenarios:")) ?? "unknown",
  productRouteCount: productRoutes.length,
  observations,
  consoleErrors,
  pageErrors,
  failures,
  screenshots: [
    "explore-desktop.png", "specification-desktop.png", "verify-desktop.png", "product-edit-captions-desktop.png",
    "explore-narrow-mobile.png", "specification-narrow-mobile.png", "verify-narrow-mobile.png", "product-edit-captions-narrow-mobile.png",
  ].map((name) => resolve(artifactDirectory, name)),
};
await writeFile(resolve(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (consoleErrors.length || pageErrors.length || failures.length) process.exitCode = 1;
