/** Millisecond-bounded ISO-8601 Duration parsing shared by the canonical upload flow. */
export function mediaRetentionMilliseconds(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 64) {
    throw new TypeError("Canonical Media upload retention must be a bounded ISO-8601 duration.");
  }
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$/u.exec(value);
  if (!match || value === "P" || value.endsWith("T")
    || !match.slice(1).some((part) => part !== undefined)) {
    throw new TypeError("Canonical Media upload retention must be an ISO-8601 duration.");
  }
  const days = BigInt(match[1] ?? "0");
  const hours = BigInt(match[2] ?? "0");
  const minutes = BigInt(match[3] ?? "0");
  const seconds = BigInt(match[4] ?? "0");
  const fractionNanos = BigInt((match[5] ?? "").padEnd(9, "0") || "0");
  const millis = days * 86_400_000n + hours * 3_600_000n + minutes * 60_000n
    + seconds * 1_000n + fractionNanos / 1_000_000n;
  if (fractionNanos % 1_000_000n !== 0n || millis < 1n || millis > 315_360_000_000n) {
    throw new TypeError("Canonical Media upload retention is outside the millisecond duration bound.");
  }
  return millis;
}

/** Compare parsed policy values, so equivalent ISO spellings bind identically. */
export function sameMediaRetention(left: unknown, right: unknown): boolean {
  try {
    return mediaRetentionMilliseconds(left) === mediaRetentionMilliseconds(right);
  } catch {
    return false;
  }
}
