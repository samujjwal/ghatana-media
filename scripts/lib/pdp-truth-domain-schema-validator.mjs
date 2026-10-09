/**
 * Definition-time JSON Schema extensions used by the Media PDP owner schema
 * conformance suite. This is a source-definition oracle, not a runtime claim.
 */
function validBound(bound) {
  return bound !== null && typeof bound === "object" && !Array.isArray(bound)
    && Object.keys(bound).sort().join(",") === "denominator,numerator"
    && Number.isSafeInteger(bound.numerator) && bound.numerator > 0
    && Number.isSafeInteger(bound.denominator) && bound.denominator > 0;
}

function validRangeDefinition(range) {
  if (range === null || typeof range !== "object" || Array.isArray(range)) return false;
  if (Object.keys(range).sort().join(",") !== "maximum,minimum") return false;
  if (!validBound(range.minimum) || !validBound(range.maximum)) return false;
  return BigInt(range.minimum.numerator) * BigInt(range.maximum.denominator)
    <= BigInt(range.maximum.numerator) * BigInt(range.minimum.denominator);
}

function rationalValueInRange(range, value) {
  if (!validRangeDefinition(range) || value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)) return false;
  if (value.numerator <= 0 || value.denominator <= 0) return false;
  const n = BigInt(value.numerator);
  const d = BigInt(value.denominator);
  const minN = BigInt(range.minimum.numerator);
  const minD = BigInt(range.minimum.denominator);
  const maxN = BigInt(range.maximum.numerator);
  const maxD = BigInt(range.maximum.denominator);
  if (n * minD < minN * d || n * maxD > maxN * d) return false;
  const gcd = (left, right) => right === 0n ? left : gcd(right, left % right);
  return gcd(n, d) === 1n;
}

export function addPdpTruthDomainKeywords(ajv) {
  ajv.addKeyword({
    keyword: "x-rationalRange",
    schemaType: "object",
    type: "object",
    errors: false,
    validate: rationalValueInRange,
  });
  return ajv;
}

export function assertPdpTruthDomainSchemaKeywords(ajv, schema) {
  const supported = new Set(["x-rationalRange"]);
  const visit = (value, path) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("x-")) {
        if (!supported.has(key) || !ajv.getKeyword(key)) {
          throw new Error(`unsupported or unregistered Media schema keyword ${key} at ${path}`);
        }
        if (key === "x-rationalRange" && !validRangeDefinition(child)) {
          throw new Error(`invalid x-rationalRange definition at ${path}; expected inclusive positive safe-integer rational minimum/maximum and no extra flags`);
        }
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(schema, "$schema");
  return true;
}
