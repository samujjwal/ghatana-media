#!/usr/bin/env node
/** Purpose: mechanically complete required PDP-3 screen-contract field shape.
 * This adds honest proposal metadata only; it does not invent acceptance.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const directory = join(root, ".product-experience/pdp-3-product-experience/screen-contracts");
const additions = {
  validation: "validation:\n  status: proposal-validation-pending-owner-review\n  rule: validate-inputs-authority-and-finality-before-dispatch",
  recovery: "recovery:\n  status: explicit-recovery-proposal-pending-owner-review\n  rule: preserve-context-and-unknown-outcomes-before-retry-or-resubmit",
  accessibility: "accessibility:\n  status: accessibility-intent-proposal-pending-owner-review\n  rule: preserve-focus-reading-order-names-and-recovery-announcements",
  localization: "localization:\n  status: Shared-localization-binding-pending-owner-review\n  rule: use-Shared-locale-formatting-and-accessibility-contracts",
  actionBindingState: "actionBindingState: proposal-intent-action-refs-owner-effect-and-finality-review-pending",
  channelDispositions: "channelDispositions:\n- channelRef: media.channel.web\n  disposition: baseline-view-contract-proposal",
  sourceRefs: "sourceRefs:\n- master-plan:section-20.2\n- .product-experience/pdp-0-product-truth",
  journeyRefs: "journeyRefs: []",
};
let changed = 0;
for (const file of readdirSync(directory).filter((name) => name.endsWith(".yaml"))) {
  const path = join(directory, file);
  let source = readFileSync(path, "utf8").replace(/\s+$/u, "");
  const missing = Object.entries(additions).filter(([field]) => !new RegExp(`^${field}:`, "mu").test(source)).map(([, value]) => value);
  if (missing.length === 0) continue;
  source = `${source}\n${missing.join("\n")}\n`;
  writeFileSync(path, source);
  changed += 1;
}
console.log(`Normalized ${changed} PDP-3 screen contracts.`);
