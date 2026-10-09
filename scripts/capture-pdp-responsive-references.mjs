import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs/implementation/verification/pdp-38/responsive-reference-captures");
const baseUrl = process.env.MEDIA_REVIEW_URL ?? "http://127.0.0.1:4179/";
const bands = [
  { band: "narrow", width: 390, height: 844 },
  { band: "medium", width: 768, height: 1024 },
  { band: "wide", width: 1280, height: 800 },
];
const views = [
  {
    viewRef: "media.view.review-transcript",
    screen: ".product-experience/pdp-3-product-experience/screen-contracts/review-transcript.yaml",
    scenario: "media.scenario.transcript-ready",
    appView: "transcript",
    criticalFacts: [
      { fact: "source-version", sourcePointer: "#/contextGoalNowNext/context", expectedText: "source-v1" },
      { fact: "transcript-version", sourcePointer: "#/domainObjectRefs/0", expectedText: "transcript-v1" },
      { fact: "source-time-reference", sourcePointer: "#/anatomy/3", expectedText: "ticks per second" },
      { fact: "recognition-uncertainty", sourcePointer: "#/contextGoalNowNext/now", expectedText: "RECOGNIZED" },
      { fact: "edit-and-review-actions", sourcePointer: "#/contextGoalNowNext/next", expectedText: "Review transcript" },
    ],
    requiredControls: ["Select a source", "Review a transcript", "Correct captions", "Compare caption versions"],
  },
  {
    viewRef: "media.view.job-status",
    screen: ".product-experience/pdp-3-product-experience/screen-contracts/job-status.yaml",
    scenario: "media.scenario.artifact-verification-outcome-unknown",
    appView: "job-status",
    criticalFacts: [
      { fact: "job-and-attempt-identity", sourcePointer: "#/anatomy/0", expectedText: "fixture-artifact-verification-job-unknown-001" },
      { fact: "observed-state", sourcePointer: "#/anatomy/2", expectedText: "OUTCOME_UNKNOWN" },
      { fact: "effect-finality-and-unknown-warning", sourcePointer: "#/anatomy/5", expectedText: "unknown" },
      { fact: "safe-recovery-action", sourcePointer: "#/anatomy/6", expectedText: "Check job outcome" },
    ],
    requiredControls: ["View job status", "Check job outcome"],
  },
  {
    viewRef: "media.view.work-in-project",
    screen: ".product-experience/pdp-3-product-experience/screen-contracts/work-in-project.yaml",
    scenario: "media.scenario.project-created-empty",
    appView: "project",
    criticalFacts: [
      { fact: "project-identity", sourcePointer: "#/anatomy/1", expectedText: "fixture-project-001" },
      { fact: "project-version", sourcePointer: "#/anatomy/1", expectedText: "project-v1" },
      { fact: "pending-work-finality", sourcePointer: "#/anatomy/3", expectedText: "CREATED" },
      { fact: "primary-safe-action", sourcePointer: "#/contextGoalNowNext/next", expectedText: "Work in a project" },
    ],
    requiredControls: ["Find projects", "Work in a project"],
  },
];
const fingerprintPaths = [
  ".product-experience/pdp-2-design-interface-system/typography-layout.yaml",
  "apps/media-experience-explorer/src/product-review.tsx",
  "apps/media-experience-explorer/src/main.ts",
  "libs/media-experience-simulation/src/fixtures.ts",
  "libs/media-experience-simulation/src/model.ts",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sourceFingerprints = {};
for (const relative of fingerprintPaths) sourceFingerprints[relative] = digest(await readFile(path.join(root, relative)));

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const captures = [];
try {
  for (const view of views) {
    for (const band of bands) {
      const page = await browser.newPage({ viewport: { width: band.width, height: band.height }, deviceScaleFactor: 1 });
      await page.goto(`${baseUrl}#explore`, { waitUntil: "networkidle" });
      await page.locator("#scenario-picker").selectOption(view.scenario);
      await page.locator("#viewport-picker").selectOption(String(band.width));
      await page.locator(".preview-toolbar [data-mode=product]").click();
      await page.locator(`[data-workflow-view="${view.appView}"]`).waitFor({ state: "visible" });
      await page.locator(`[data-workflow-view="${view.appView}"]`).click();
      await page.locator(".candidate-presentation-shell").waitFor({ state: "visible" });
      await page.waitForTimeout(250);

      const observation = await page.evaluate(() => {
        const shell = document.querySelector(".candidate-presentation-shell");
        const app = document.querySelector(".product-app");
        if (!shell || !app) throw new Error("Candidate Media presentation shell is absent.");
        const visibleText = document.body.innerText.replace(/\s+/gu, " ").trim();
        const controls = [...document.querySelectorAll("button, input, select, textarea, [role=button]")]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            name: element.getAttribute("aria-label") ?? element.innerText ?? element.getAttribute("placeholder") ?? "",
            disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement ? element.disabled : false,
          }));
        const actions = JSON.parse(shell.dataset.actionIds ?? "[]");
        const propProjection = {
          rendererExport: shell.dataset.rendererExport,
          rendererVariant: shell.dataset.rendererVariant,
          fixtureId: shell.dataset.fixtureId,
          stateRef: shell.dataset.stateRef,
          actionPort: shell.dataset.actionPort,
          errorPort: shell.dataset.errorPort,
          actionIds: actions,
          controls,
          headingTexts: [...document.querySelectorAll("h1,h2,h3,[role=heading]")].filter((element) => element.getClientRects().length > 0).map((element) => element.textContent?.trim() ?? ""),
        };
        return { visibleText, propProjection };
      });
      const missingCriticalFacts = view.criticalFacts.filter((fact) => !observation.visibleText.toLowerCase().includes(fact.expectedText.toLowerCase()));
      if (view.viewRef !== "media.view.work-in-project" && missingCriticalFacts.length) throw new Error(`${view.viewRef} at ${band.width}px is missing visible critical fact(s): ${missingCriticalFacts.join(", ")}`);
      const visibleControls = observation.propProjection.controls.map((control) => control.name).join("\n").toLowerCase();
      const missingControls = view.requiredControls.filter((control) => !visibleControls.includes(control.toLowerCase()));
      if (missingControls.length) throw new Error(`${view.viewRef} at ${band.width}px is missing visible control(s): ${missingControls.join(", ")}`);
      const propFingerprint = digest(JSON.stringify(observation.propProjection));
      const name = `${view.viewRef.split(".").at(-1)}-${band.band}-${band.width}.png`;
      const screenshot = path.join(output, name);
      await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
      const imageBytes = await readFile(screenshot);
      captures.push({
        viewRef: view.viewRef,
        contractPath: view.screen,
        scenarioId: view.scenario,
        viewport: { band: band.band, widthCssPx: band.width, heightCssPx: band.height, deviceScaleFactor: 1 },
        status: "RENDERED_SIMULATION_FIXTURE; NOT_ADMITTED; NOT_ACCEPTANCE",
        screenshot: name,
        screenshotSha256: digest(imageBytes),
        contractSha256: sourceFingerprints[view.screen] ?? digest(await readFile(path.join(root, view.screen))),
        layoutAndRendererSourceFingerprints: sourceFingerprints,
        propProjectionSha256: propFingerprint,
        propProjection: observation.propProjection,
        criticalFactsExpected: view.criticalFacts,
        criticalFactsObserved: view.criticalFacts.filter((fact) => !missingCriticalFacts.includes(fact)),
        missingCriticalFacts,
        requiredControlsObserved: view.requiredControls,
        structuralChecks: { criticalFactsVisible: missingCriticalFacts.length === 0, controlsVisible: missingControls.length === 0, admittedRuntime: false, humanComprehension: "NOT_RUN", accessibilityAcceptance: "NOT_RUN" },
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
}

const contractOnly = {
  viewRef: "media.view.review-rights-and-consent",
  contractPath: ".product-experience/pdp-3-product-experience/screen-contracts/review-rights-and-consent.yaml",
  status: "CONTRACT_ONLY_NO_RENDERED_REFERENCE",
  missingRenderDependency: "A rights-and-consent screen contract and typed component contracts exist, but the existing ProductReview renderer has no rights-and-consent view route or MediaProductRenderer kind, and its fixture has no bound action adapter for this screen. The supported view union is setup/projects/project/source/transcript/captions/versions/browse/import/artifact/review-activity/job-status. Therefore no existing Media composition renders the declared screen; this capture set records the gap rather than synthesizing a GUI.",
  requiredReusableComponentContracts: [
    {
      componentId: "media.component.rights-retention-review",
      typedDefinitionRef: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#components/@id=media.component.rights-retention-review/typedDefinition",
      contractStatus: "OWNER_DEFINED_TYPED_COMPONENT_CONTRACT; INDEPENDENT_REVIEW_OPEN",
      requiredProps: ["subjectVersionRef", "authorityRef", "rightOrConsent", "scope", "validity", "retentionDisposition", "decisionHistory", "nextActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    },
    {
      componentId: "media.component.provenance-summary",
      typedDefinitionRef: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#components/@id=media.component.provenance-summary/typedDefinition",
      contractStatus: "OWNER_DEFINED_TYPED_COMPONENT_CONTRACT; INDEPENDENT_REVIEW_OPEN",
    },
    {
      componentId: "media.component.artifact-integrity-summary",
      typedDefinitionRef: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#components/@id=media.component.artifact-integrity-summary/typedDefinition",
      contractStatus: "OWNER_DEFINED_TYPED_COMPONENT_CONTRACT; INDEPENDENT_REVIEW_OPEN",
    },
  ],
  actionAdapterDependency: ".product-experience/pdp-3-product-experience/screen-contracts/review-rights-and-consent.yaml#actionConsequences",
  notCapturedAtBands: bands.map(({ band, width, height }) => ({ band, widthCssPx: width, heightCssPx: height, status: "NO_RENDER_COMPONENT" })),
  runtimeAdmission: "NOT_ADMITTED",
  humanComprehension: "NOT_RUN",
  accessibilityAcceptance: "NOT_RUN",
};
const manifest = {
  schemaVersion: "media.pdp-responsive-rendered-reference-captures.v1",
  generatedAt: new Date().toISOString(),
  sourceBaseUrl: baseUrl,
  sourceFingerprints,
  layoutSource: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml#responsiveCompositionReferences",
  captures,
  contractOnly,
  limits: ["Synthetic review fixture only", "Screenshots are structural reference evidence, not conformance approval", "No human comprehension study or independent accessibility review was performed"],
};
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ captureCount: captures.length, contractOnly: contractOnly.viewRef, output }, null, 2));
