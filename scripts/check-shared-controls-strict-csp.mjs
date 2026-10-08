#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const port = 4180;
const baseUrl = `http://127.0.0.1:${port}`;
const build = spawnSync("pnpm", ["--filter", "@ghatana/media-experience-explorer", "build"], {
  cwd: root,
  env: { ...process.env, MEDIA_STRICT_CSP_FIXTURE: "1" },
  encoding: "utf8",
  stdio: "pipe",
});
assert.equal(build.status, 0, `production fixture build failed:\n${build.stdout}\n${build.stderr}`);

const server = spawn("pnpm", ["--filter", "@ghatana/media-experience-explorer", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
server.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
let browser;

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Explorer production preview exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/strict-csp-controls.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* preview is still starting */ }
    await delay(250);
  }
  assert.ok(ready, `Explorer production preview did not become ready:\n${serverOutput}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const violations = [];
  const pageErrors = [];
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const response = await page.goto(`${baseUrl}/strict-csp-controls.html`, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200);
  assert.match(response?.headers()["content-security-policy"] ?? "", /style-src-attr 'none'/u);
  await page.getByRole("button", { name: "Save" }).waitFor();

  const visual = await page.evaluate(() => {
    const button = document.querySelector(".gh-button:not([data-loading]):not(:disabled)");
    const loadingButton = document.querySelector('.gh-button[data-loading=""]');
    const spinner = loadingButton?.querySelector(".gh-spinner");
    const badge = document.querySelector(".gh-badge");
    const select = document.querySelector(".gh-select__control");
    const textArea = document.querySelector(".gh-text-area__input");
    const textField = document.querySelector(".gh-text-field__input");
    const control = document.querySelector(".gh-text-field__control");
    const computed = (element) => element ? getComputedStyle(element) : null;
    return {
      inlineStyles: [...document.querySelectorAll("*")].filter((node) => node.hasAttribute("style")).map((node) => node.outerHTML),
      styleElements: document.querySelectorAll("style").length,
      button: computed(button) && { display: computed(button).display, background: computed(button).backgroundColor, border: computed(button).borderTopStyle, width: computed(button).width },
      loading: loadingButton && { disabled: loadingButton.disabled, busy: loadingButton.getAttribute("aria-busy"), animation: spinner && computed(spinner).animationName, indicatorOpacity: computed(spinner?.querySelector(".gh-spinner__indicator")).opacity },
      badge: computed(badge) && { display: computed(badge).display, background: computed(badge).backgroundColor, radius: computed(badge).borderRadius },
      select: computed(select) && { border: computed(select).borderTopStyle, color: computed(select).borderTopColor, width: computed(select).width },
      textArea: computed(textArea) && { minHeight: computed(textArea).minHeight, resize: computed(textArea).resize, border: computed(textArea).borderTopStyle },
      textField: computed(textField) && { padding: computed(textField).paddingBlockStart, fontSize: computed(textField).fontSize },
      fieldControl: computed(control) && { border: computed(control).borderTopStyle, radius: computed(control).borderTopLeftRadius },
    };
  });
  assert.deepEqual(visual.inlineStyles, [], "no rendered descendant may receive a library-owned inline style attribute");
  assert.equal(visual.styleElements, 0, "control rendering must not inject a style element");
  assert.deepEqual(visual.button && { display: visual.button.display, border: visual.button.border }, { display: "inline-flex", border: "solid" });
  assert.notEqual(visual.button?.background, "rgba(0, 0, 0, 0)");
  assert.ok(Number.parseFloat(visual.button?.width ?? "0") > 0);
  assert.deepEqual(visual.loading && { disabled: visual.loading.disabled, busy: visual.loading.busy }, { disabled: true, busy: "true" });
  assert.equal(visual.loading?.animation, "gh-spinner-rotate");
  assert.equal(visual.loading?.indicatorOpacity, "0.9");
  assert.equal(visual.badge?.display, "inline-flex");
  assert.notEqual(visual.badge?.background, "rgba(0, 0, 0, 0)");
  assert.equal(visual.select?.border, "solid");
  assert.match(visual.select?.color ?? "", /rgb\(/u);
  assert.equal(visual.textArea?.minHeight, "80px");
  assert.equal(visual.textArea?.resize, "none");
  assert.equal(visual.textArea?.border, "solid");
  assert.equal(visual.fieldControl?.border, "solid");
  assert.notEqual(visual.fieldControl?.radius, "0px");
  assert.ok(Number.parseFloat(visual.textField?.fontSize ?? "0") > 14, "large TextField size selector must apply from external CSS");

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".gh-spinner").evaluate((node) => getComputedStyle(node).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.matches(".gh-button:not([data-loading]):not(:disabled)")), true);
  await page.emulateMedia({ forcedColors: "active" });
  const focusedButton = page.locator(".gh-button:not([data-loading]):not(:disabled)");
  assert.equal(await focusedButton.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
  const forcedColorsOutline = await focusedButton.evaluate((node) => getComputedStyle(node).outlineColor);
  assert.match(forcedColorsOutline, /rgba?\(/u);
  assert.notEqual(forcedColorsOutline, "rgba(0, 0, 0, 0)");
  assert.equal(await page.getByRole("button", { name: "Disabled" }).evaluate((node) => getComputedStyle(node).forcedColorAdjust), "auto");
  await page.emulateMedia({ forcedColors: "none" });

  assert.equal(await focusedButton.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.matches(".gh-select__control")), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.matches(".gh-text-area__input")), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.matches(".gh-text-field__input")), true);

  violations.push(...await page.evaluate(() => window.__cspViolations));
  assert.deepEqual(violations, [], "production controls must produce zero script/style CSP violations");
  assert.deepEqual(pageErrors, [], "production control fixture must execute without browser errors");
  console.log("Shared controls strict-CSP production browser check passed: external CSS appearance, loading/disabled/error states, reduced motion, forced colors, keyboard focus, no inline styles/style elements, and zero script/style CSP violations.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
