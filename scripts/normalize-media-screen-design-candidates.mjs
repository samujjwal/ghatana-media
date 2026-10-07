#!/usr/bin/env node
/** Record explicit PDP-2 template/layout candidates for each PDP-3 screen. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, ".product-experience/pdp-3-product-experience/screen-contracts");
const bindings = {
  "adjust-color.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "animate-media.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "arrange-scenes.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "authenticate-and-select-context.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "browse-media.yaml": ["media.gui.template.collection", "media.gui.layout.collection"],
  "check-job-outcome.yaml": ["media.gui.template.job-observation", "media.gui.layout.job-observation"],
  "check-processing-options.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "check-processing-readiness.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "choose-eligible-processing-option.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "compare-caption-versions.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.review"],
  "compare-results.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.review"],
  "compose-media.yaml": ["media.gui.template.render-preparation-and-review", "media.gui.layout.render"],
  "compose-scene.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "correct-captions.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "create-audio.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "create-image.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "create-media.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "create-video.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "deliver-output.yaml": ["media.gui.template.render-preparation-and-review", "media.gui.layout.render"],
  "edit-captions.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "edit-media-region.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "edit-media.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "explore-simulation.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "find-projects.yaml": ["media.gui.template.collection", "media.gui.layout.collection"],
  "find-task-guidance.yaml": ["media.gui.template.collection", "media.gui.layout.collection"],
  "import-media.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "improve-media.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "inspect-media.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "inspect-output.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.review"],
  "inspect-provenance.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.record-detail"],
  "job-status.yaml": ["media.gui.template.job-observation", "media.gui.layout.job-observation"],
  "prepare-render.yaml": ["media.gui.template.render-preparation-and-review", "media.gui.layout.render"],
  "resume-work.yaml": ["media.gui.template.collection", "media.gui.layout.collection"],
  "review-activity.yaml": ["media.gui.template.collection", "media.gui.layout.collection"],
  "review-creation-plan.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "review-dubbing.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.review"],
  "review-exact-version.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.review"],
  "review-outputs.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.review"],
  "review-quality.yaml": ["media.gui.template.review-and-compare", "media.gui.layout.review"],
  "review-rights-and-consent.yaml": ["media.gui.template.consent-gate", "media.gui.layout.consent"],
  "review-transcript.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "review-workspace-settings.yaml": ["media.gui.template.consent-gate", "media.gui.layout.consent"],
  "select-source.yaml": ["media.gui.template.task-setup", "media.gui.layout.task-setup"],
  "transcription-progress.yaml": ["media.gui.template.job-observation", "media.gui.layout.job-observation"],
  "use-authorized-voice.yaml": ["media.gui.template.consent-gate", "media.gui.layout.consent"],
  "work-in-project.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
  "work-with-speech.yaml": ["media.gui.template.workbench", "media.gui.layout.media-workbench"],
};

const files = readdirSync(directory).filter((file) => file.endsWith(".yaml") && file !== "artifact-verification-job-family.yaml").sort();
const missing = files.filter((file) => !bindings[file]);
const stale = Object.keys(bindings).filter((file) => !files.includes(file));
if (missing.length || stale.length) {
  throw new Error(`Screen design candidate mapping mismatch; missing mappings: ${missing.join(", ") || "none"}; stale mappings: ${stale.join(", ") || "none"}`);
}

let changed = 0;
for (const file of files) {
  const path = join(directory, file);
  const [templateId, layoutId] = bindings[file];
  let source = readFileSync(path, "utf8");
  const replaceRequired = (pattern, replacement, field) => {
    if (!pattern.test(source)) throw new Error(`${file} has no ${field} field`);
    source = source.replace(pattern, replacement);
  };
  const upsertAfter = (key, value, anchor) => {
    const pattern = new RegExp(`^${key}:.*$`, "mu");
    if (pattern.test(source)) source = source.replace(pattern, `${key}: ${value}`);
    else {
      const anchorPattern = new RegExp(`^(${anchor}:.*)$`, "mu");
      if (!anchorPattern.test(source)) throw new Error(`${file} has no ${anchor} field for ${key}`);
      source = source.replace(anchorPattern, `$1\n${key}: ${value}`);
    }
  };
  replaceRequired(/^templateId:.*$/mu, `templateId: ${templateId}`, "templateId");
  upsertAfter("templateBindingStatus", "candidate-by-screen-purpose; owner-review-pending", "templateId");
  // Keep the human-readable template contract linked to the same real
  // candidate in the PDP-2 catalog. Legacy media.template.* refs are not IDs
  // in that authority and otherwise remain broken edges in architecture
  // analysis even after templateId is populated.
  replaceRequired(/^  templateRef:.*$/mu, `  templateRef: ${templateId}`, "templateContract.templateRef");
  replaceRequired(/^layoutIds:.*$/mu, `layoutIds: [${layoutId}]`, "layoutIds");
  upsertAfter("layoutBindingStatus", "candidate-by-template-and-screen-purpose; owner-review-pending", "layoutIds");
  replaceRequired(/^  templateId:.*$/mu, "  templateId: candidate-template-link-owner-review-pending", "fieldBindingStatus.templateId");
  replaceRequired(/^  layoutIds:.*$/mu, "  layoutIds: candidate-layout-link-owner-review-pending", "fieldBindingStatus.layoutIds");
  if (source !== readFileSync(path, "utf8")) {
    writeFileSync(path, source);
    changed += 1;
  }
}
console.log(`Recorded candidate template/layout links in ${changed} screen contracts; none are marked accepted.`);
