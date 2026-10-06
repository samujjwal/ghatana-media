import test from "node:test";
import assert from "node:assert/strict";
import { auditConfig, classifyTouchTarget, createAuditReport, manualGates, setTextScaleWithCdp, viewports } from "../scripts/check-experience-browser.mjs";

test("browser audit retains the six ordered responsive viewport sweeps", () => {
  assert.deepEqual(viewports.map(({ name }) => name), ["wide", "desktop", "compact-desktop", "tablet", "mobile", "narrow-mobile"]);
  assert.deepEqual(viewports.map(({ width }) => width), [1536, 1280, 1024, 768, 390, 320]);
  assert.equal(auditConfig.baseUrl, process.env.MEDIA_EXPLORER_URL ?? "http://127.0.0.1:4179/");
});

test("report declares requested browser coverage without equating geometry with design quality", () => {
  const report = createAuditReport({
    baseUrl: "http://127.0.0.1:4179/",
    viewports,
    observations: ["text sizing 200%: exercised"],
    screenshots: ["review.png"],
  });
  for (const coverage of ["100% and 200% text sizing", "browser zoom/reflow", "keyboard", "forced colors", "reduced motion", "long-label localization stress", "RTL when admitted", "touch targets", "focus not obscured"]) {
    assert.ok(report.coverage.includes(coverage), `missing declared coverage: ${coverage}`);
  }
  assert.deepEqual(report.manualGates, manualGates);
  assert.equal(report.failures.length, 0);
  assert.equal(report.screenshots[0], "review.png");
  assert.equal(JSON.stringify(report).includes('"status":"PASS"'), false);
});

test("screen-reader, canonical visual references, and independent review remain explicit unverified gates", () => {
  assert.equal(manualGates.screenReader.status, "MANUAL_NOT_VERIFIED");
  assert.match(manualGates.screenReader.reason, /No supported screen-reader automation/u);
  assert.equal(manualGates.independentVisualReview.status, "MANUAL_NOT_VERIFIED");
  assert.match(manualGates.independentVisualReview.reason, /do not constitute independent expert visual review/u);
  assert.equal(manualGates.canonicalVisualReferences.status, "NOT_SUPPLIED");
});

test("text scaling uses the DevTools CSS domain and degrades to an explicit unsupported result", async () => {
  const calls = [];
  const supported = await setTextScaleWithCdp({
    async send(method, params) {
      calls.push({ method, params });
      if (method === "CSS.createStyleSheet") return { styleSheetId: "audit-sheet" };
      return {};
    },
  }, "main-frame", null, 2, 16);
  assert.deepEqual(supported, { supported: true, styleSheetId: "audit-sheet" });
  assert.deepEqual(calls.map(({ method }) => method), ["CSS.createStyleSheet", "CSS.setStyleSheetText"]);
  assert.match(calls[1].params.text, /font-size: 32px !important/u);

  const unsupported = await setTextScaleWithCdp({
    async send() { throw new Error("stylesheet injection unavailable"); },
  }, "main-frame", null, 2, 16);
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /stylesheet injection unavailable/u);
});

test("touch audit excludes only disabled or hidden targets and delegates transparent toggles to visible labels", () => {
  const base = { disabled: false, hidden: false, inert: false, ariaHidden: false, rendered: true, display: "block", visibility: "visible", opacity: "1", delegatedVisibleLabel: false };
  assert.deepEqual(classifyTouchTarget({ ...base, disabled: true }), { include: false, reason: "disabled" });
  assert.deepEqual(classifyTouchTarget({ ...base, ariaHidden: true }), { include: false, reason: "hidden or not rendered" });
  assert.deepEqual(classifyTouchTarget({ ...base, opacity: "0", delegatedVisibleLabel: true }), { include: false, reason: "visually-hidden control represented by its visible label" });
  assert.deepEqual(classifyTouchTarget(base), { include: true, reason: "enabled visible target" });
  assert.equal(classifyTouchTarget({ ...base, width: 280, height: 10, type: "range" }).include, true);
  assert.equal(classifyTouchTarget({ ...base, width: 25.21875, height: 8.6875, tagName: "BUTTON" }).include, true);
});
