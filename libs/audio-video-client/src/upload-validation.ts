const CANONICAL_MEDIA_CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;

/** PDP-1 begin-upload content type grammar and bound shared by SDK and CLI validation. */
export function isCanonicalMediaContentType(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 127
    && CANONICAL_MEDIA_CONTENT_TYPE_PATTERN.test(value);
}
