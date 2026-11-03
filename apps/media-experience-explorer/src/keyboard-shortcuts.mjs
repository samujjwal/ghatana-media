const interactiveTargetSelector = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='textbox']",
  "[role='combobox']",
].join(", ");

/** Keep single-key mode shortcuts from stealing input intended for controls. */
export function isInteractiveShortcutTarget(target) {
  return typeof target?.closest === "function"
    && target.closest(interactiveTargetSelector) !== null;
}
