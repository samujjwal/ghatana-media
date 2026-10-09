const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const VIEW_SCHEMA_SOURCE = ".product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml";
const closedObjectSchema = (schema) => record(schema) && schema.type === "object" && schema.additionalProperties === false &&
  Array.isArray(schema.required) && record(schema.properties) && schema.required.length > 0 &&
  schema.required.every((key) => typeof key === "string" && Object.hasOwn(schema.properties, key)) &&
  Object.keys(schema.properties).every((key) => record(schema.properties[key]));

/**
 * Project typed Media-local view observations into ExperienceSpecification UI
 * state identities. These refs are deliberately distinct from PDP-1 machine
 * state IDs; no lifecycle mapping or runtime evidence is inferred.
 */
export function buildLocalViewObservationStateProjection({ predicates, factSchemas, views, viewDispositions }) {
  if (!Array.isArray(predicates) || !Array.isArray(factSchemas) || !Array.isArray(views) || !Array.isArray(viewDispositions)) {
    throw new TypeError("View-state projection inputs must be arrays");
  }
  const viewIds = new Set(views.map((view) => view?.id));
  if (viewIds.size !== views.length || [...viewIds].some((id) => typeof id !== "string" || !id)) throw new Error("View identity census is invalid");
  const schemaById = new Map(factSchemas.map((schema) => [schema?.id, schema]));
  const schemaByKind = new Map(factSchemas.map((schema) => [schema?.factKind, schema]));
  const resolveClosedSchema = (schema, seen = new Set()) => {
    if (!schema || seen.has(schema.id)) return null;
    if (schema.closedSchema) return closedObjectSchema(schema.closedSchema) ? schema.closedSchema : null;
    if (typeof schema.sameRawSchemaAs !== "string" || !schema.sameRawSchemaAs) return null;
    seen.add(schema.id);
    const target = schemaById.get(schema.sameRawSchemaAs) ?? schemaByKind.get(schema.sameRawSchemaAs);
    return resolveClosedSchema(target, seen);
  };
  const explicitUnknownSchema = (schema) => schema?.schemaDisposition === "RAW_SOURCE_FACT_SCHEMA_NOT_YET_AUTHORED; labels remain UNKNOWN";
  if (schemaById.size !== factSchemas.length || schemaByKind.size !== factSchemas.length || factSchemas.some((schema) =>
    typeof schema?.id !== "string" || !schema.id.startsWith("media.view-observation-schema.") ||
    typeof schema.factKind !== "string" || !schema.factKind || (!resolveClosedSchema(schema) && !explicitUnknownSchema(schema)))) {
    throw new Error("View fact-schema identities or closed schema definitions are invalid");
  }
  const dispositionByView = new Map();
  for (const disposition of viewDispositions) {
    if (!record(disposition) || !viewIds.has(disposition.viewRef) || disposition.id !== disposition.dispositionId ||
        typeof disposition.id !== "string" || !disposition.id.startsWith("media.view-state-disposition.") ||
        disposition.runtimeAdmission !== "NOT_ADMITTED" || typeof disposition.screenContractRef !== "string" ||
        !Array.isArray(disposition.displayedStates) || !Array.isArray(disposition.stateLabelDispositions) ||
        !Array.isArray(disposition.sourceRefs) || disposition.sourceRefs.length === 0 ||
        disposition.stateLabelDispositions.length !== disposition.displayedStates.length ||
        disposition.stateLabelDispositions.some((row, index) => row?.label !== disposition.displayedStates[index] || typeof row.meaning !== "string" || !row.meaning.trim()) ||
        dispositionByView.has(disposition.viewRef)) {
      throw new Error("View-state source disposition is missing, foreign, or structurally unresolved");
    }
    dispositionByView.set(disposition.viewRef, disposition);
  }
  const predicateIds = new Set();
  const refsByView = new Map(views.map((view) => [view.id, []]));
  const states = predicates.map((predicate) => {
    const match = typeof predicate?.factSchemaRef === "string" && predicate.factSchemaRef.match(/^\.product-experience\/pdp-3-product-experience\/view-observation-input-contracts\.yaml#factSchemas\/@id=([^/]+)$/u);
    const factSchema = match ? schemaById.get(match[1]) : undefined;
    if (!predicate?.id?.startsWith("media.view-observation.") || predicateIds.has(predicate.id) || !refsByView.has(predicate.viewRef) ||
        typeof predicate.label !== "string" || !predicate.label.trim() || typeof predicate.meaning !== "string" || !predicate.meaning.trim() ||
        !record(predicate.factScope) || predicate.factScope.viewRef !== predicate.viewRef || !factSchema || factSchema.id !== match[1] || factSchema.factKind !== predicate.factKind ||
        (!resolveClosedSchema(factSchema) && !explicitUnknownSchema(factSchema)) || !dispositionByView.has(predicate.viewRef)) {
      throw new Error(`Invalid local view-state predicate binding: ${predicate?.id ?? "<missing id>"}`);
    }
    predicateIds.add(predicate.id);
    refsByView.get(predicate.viewRef).push(predicate.id);
    return {
      id: predicate.id,
      name: `${predicate.viewRef}: ${predicate.label}`,
      description: `${predicate.meaning} This is a local display observation; it does not authorize a transition or assert runtime evidence.`,
      isTerminal: false,
      invariants: [`viewRef:${predicate.viewRef}`, `factKind:${predicate.factKind}`, `factSchemaRef:${predicate.factSchemaRef}`,
        `factSchemaDisposition:${resolveClosedSchema(factSchema) ? "CLOSED_SOURCE_SCHEMA" : "UNKNOWN_SCHEMA_PENDING"}`,
        "display-only; runtimeAdmission=NOT_ADMITTED"],
    };
  });
  if (dispositionByView.size !== views.length || predicates.length === 0 ||
      views.some((view) => refsByView.get(view.id).length === 0)) throw new Error("View-state source census mismatch");
  if (predicates.length !== predicateIds.size) throw new Error("View predicate IDs are not unique");
  return { states, refsByView };
}
