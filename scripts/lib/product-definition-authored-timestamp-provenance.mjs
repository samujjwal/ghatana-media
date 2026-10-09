// The Media ProductDefinition candidate currently has no canonical source
// field for createdAt or updatedAt. Projection build time is not product
// authority provenance. Adding a timestamp source requires a separately
// reviewed exact source selector in this allowlist.
const CANONICAL_TIMESTAMP_SOURCES = new Map();

function resolveSourcePath(source, path) {
  if (!Array.isArray(path) || path.length === 0) return undefined;
  return path.reduce((value, part) => {
    if (Array.isArray(value) && Number.isInteger(part)) return value[part];
    if (typeof part !== "string" || !part || part === "__proto__") return undefined;
    return value?.[part];
  }, source);
}

/**
 * Enforce that optional public authored timestamps never enter a ProductDefinition
 * candidate from generation time or an arbitrary timestamp-shaped source field.
 */
export function validateProductDefinitionTimestampProvenance(candidate, fieldSources, sourceDocuments) {
  for (const field of ["createdAt", "updatedAt"]) {
    if (!Object.hasOwn(candidate ?? {}, field)) continue;
    const mapping = fieldSources?.[field];
    const sourceRef = mapping?.sourceRef;
    const sourcePath = mapping?.sourcePath;
    if (typeof sourceRef !== "string" || !Array.isArray(sourcePath) || !CANONICAL_TIMESTAMP_SOURCES.has(`${field}:${sourceRef}#${sourcePath.join("/")}`)) {
      throw new Error(`${field} has no reviewed canonical authored timestamp source; projection generation time cannot populate it`);
    }
    const sourceValue = resolveSourcePath(sourceDocuments?.[sourceRef], sourcePath);
    if (typeof sourceValue !== "string" || candidate[field] !== sourceValue) {
      throw new Error(`${field} must exactly equal its reviewed canonical source value`);
    }
  }
  return true;
}
