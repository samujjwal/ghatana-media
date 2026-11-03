import assert from "node:assert/strict";
import test from "node:test";
import { isInteractiveShortcutTarget } from "../src/keyboard-shortcuts.mjs";

function targetMatching(selector) {
  return {
    closest: (expectedSelector) => expectedSelector
      .split(",")
      .some((candidate) => candidate.trim() === selector)
      ? {}
      : null,
  };
}

test("global mode shortcuts do not steal keys from interactive controls", () => {
  for (const selector of [
    "button",
    "a",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='textbox']",
  ]) {
    assert.equal(isInteractiveShortcutTarget(targetMatching(selector)), true, selector);
  }
});

test("global mode shortcuts remain available from non-interactive Explorer regions", () => {
  assert.equal(isInteractiveShortcutTarget({ closest: () => null }), false);
  assert.equal(isInteractiveShortcutTarget(null), false);
});
