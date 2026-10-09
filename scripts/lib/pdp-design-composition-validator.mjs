import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateMediaIdentityHandoffResult, validateMediaIdentityHandoffRequest } from "./media-identity-handoff-definition.mjs";
import { convertMediaTime } from "./media-temporal-spatial-definition-model.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { parse } = createRequire(resolve(ROOT, "../ghatana-tools/package.json"))("yaml");
const PATHS = Object.freeze({
  grammar: ".product-experience/pdp-2-design-interface-system/gui/composition-validation-grammar.yaml",
  screenRegistry: ".product-experience/pdp-3-product-experience/screen-registry.yaml",
  screenContracts: ".product-experience/pdp-3-product-experience/screen-contracts",
  templates: ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
  layouts: ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
  recipes: ".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml",
  patterns: ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml",
  components: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml",
  componentValueTypes: ".product-experience/pdp-2-design-interface-system/component-value-types.yaml",
  canonicalValueObjects: ".product-experience/pdp-1-domain-data/value-objects.yaml",
  canonicalScreens: ".product-experience/pdp-3-product-experience/screen-registry.yaml",
  canonicalActions: ".product-experience/pdp-3-product-experience/action-registry.yaml",
  canonicalGoals: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
  reuseAudit: ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml",
  actions: ".product-experience/pdp-3-product-experience/action-registry.yaml",
});

const parsedYamlCache = new Map();
const readYaml = (root, path) => {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return null;
  const bytes = readFileSync(absolute);
  const revision = createHash("sha256").update(bytes).digest("hex");
  const cacheKey = `${absolute}\u0000${revision}`;
  if (!parsedYamlCache.has(cacheKey)) parsedYamlCache.set(cacheKey, parse(bytes.toString("utf8")));
  return { revision, value: parsedYamlCache.get(cacheKey) };
};
const load = (root, path) => readYaml(root, path)?.value ?? null;
const records = (catalog, key) => Array.isArray(catalog?.[key]) ? catalog[key] : [];
const unique = (values) => new Set(values).size === values.length;
const typedValidatorCache = new Map();
const typedSchemaEngineCache = new Map();

function typedSchemaEngine(root) {
  const typeSource = readYaml(root, PATHS.componentValueTypes);
  if (!typeSource) throw new Error("closed Media value-type registry is absent");
  const cacheKey = `${root}\u0000${typeSource.revision}`;
  if (typedSchemaEngineCache.has(cacheKey)) return typedSchemaEngineCache.get(cacheKey);
  const typeLibrary = typeSource.value;
  if (!typeLibrary) throw new Error("closed Media value-type registry is absent");
  const typeRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
  const Ajv2020 = typeRequire("ajv/dist/2020").default;
  const addFormats = typeRequire("ajv-formats").default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(typeLibrary);
  const engine = { ajv, validators: new Map(), typeLibrary };
  typedSchemaEngineCache.set(cacheKey, engine);
  return engine;
}

function compileTypedSchema(root, schema) {
  const engine = typedSchemaEngine(root);
  const key = JSON.stringify(schema);
  if (!engine.validators.has(key)) engine.validators.set(key, engine.ajv.compile(schema));
  return engine.validators.get(key);
}

export function loadCompositionCatalogs(root = ROOT) {
  const actionRegistry = load(root, PATHS.actions);
  return structuredClone({
    grammar: load(root, PATHS.grammar),
    templates: records(load(root, PATHS.templates), "templates"),
    layouts: records(load(root, PATHS.layouts), "layouts"),
    recipes: records(load(root, PATHS.recipes), "recipes"),
    patterns: records(load(root, PATHS.patterns), "patterns"),
    components: records(load(root, PATHS.components), "components"),
    actions: [...records(actionRegistry, "actions"), ...records(actionRegistry, "ownerDefinedActions")],
  });
}

export function validateCatalogRelations(catalogs) {
  const errors = [];
  if (!unique(catalogs.actions.map((record) => record.id))) errors.push("action registry identities, including owner-defined actions, must be unique");
  const templates = new Map(catalogs.templates.map((record) => [record.id, record]));
  const layouts = new Map(catalogs.layouts.map((record) => [record.id, record]));
  const recipes = new Map(catalogs.recipes.map((record) => [record.id, record]));
  const patterns = new Map(catalogs.patterns.map((record) => [record.id, record]));

  if (!catalogs.grammar || catalogs.grammar.schemaVersion !== "media.gui-composition-validation-grammar.v1") {
    errors.push("composition validation grammar is missing or has an unsupported schema");
    return errors;
  }
  const normativeRecords = catalogs.grammar.normativeRuleRecords;
  const normativeIds = Array.isArray(normativeRecords) ? normativeRecords.map((record) => record.id) : [];
  const expectedNormativeIds = [
    ...Object.keys(catalogs.grammar.linkRules ?? {}).map((key) => `media.gui.composition-rule.link.${key}`),
    ...Object.keys(catalogs.grammar.accessibilityRules ?? {}).map((key) => `media.gui.composition-rule.accessibility.${key}`),
    ...Object.keys(catalogs.grammar.regionContracts?.templates ?? {}).map((id) => `media.gui.composition-region.template.${id.replace(/^media\.gui\.template\./u, "")}`),
    ...Object.keys(catalogs.grammar.regionContracts?.patterns ?? {}).map((id) => `media.gui.composition-region.pattern.${id.replace(/^media\.gui\.pattern\./u, "")}`),
  ];
  if (!Array.isArray(normativeRecords) || !unique(normativeIds) || JSON.stringify([...normativeIds].sort()) !== JSON.stringify([...expectedNormativeIds].sort())) {
    errors.push("normativeRuleRecords must uniquely enumerate every link, accessibility, and template/pattern region obligation");
  }
  for (const record of normativeRecords ?? []) {
    if (typeof record.sourceRef !== "string" || !record.sourceRef.includes("#") || typeof record.authorityRef !== "string" || !record.authorityRef.includes("#") || typeof record.normativeRequirement !== "string" || !record.normativeRequirement.trim()) {
      errors.push(`${record.id ?? "normative rule"}: exact source, authority, and requirement are required`);
    }
  }
  for (const template of catalogs.templates) {
    if (!Array.isArray(template.regions) || template.regions.length === 0 || !unique(template.regions)) {
      errors.push(`${template.id}: canonical template regions must be nonempty and unique`);
    } else if (JSON.stringify(template.regions) !== JSON.stringify(catalogs.grammar.regionContracts?.templates?.[template.id])) {
      errors.push(`${template.id}: template required-region sequence differs from central composition grammar`);
    }
    const recipeRefs = template.recipeRefs;
    if (!Array.isArray(recipeRefs) || recipeRefs.length === 0 || !unique(recipeRefs)) errors.push(`${template.id}: recipeRefs must be nonempty and unique`);
    for (const recipeRef of recipeRefs ?? []) {
      const recipe = recipes.get(recipeRef);
      if (!recipe) errors.push(`${template.id}: unknown reciprocal recipe ${recipeRef}`);
      else if (recipe.templateRef !== template.id) errors.push(`${template.id}: recipe ${recipeRef} does not point back to its template`);
    }
    const layoutRefs = template.compatibleLayoutRefs;
    if (!Array.isArray(layoutRefs) || !unique(layoutRefs)) errors.push(`${template.id}: compatibleLayoutRefs must be a unique array`);
    for (const layoutRef of layoutRefs ?? []) {
      const layout = layouts.get(layoutRef);
      if (!layout) errors.push(`${template.id}: unknown compatible layout ${layoutRef}`);
      else if (!layout.compatibleTemplateRefs?.includes(template.id)) errors.push(`${template.id}: layout ${layoutRef} does not reciprocally list the template`);
    }
    const allowedPatterns = [...(template.patterns ?? []), ...Object.keys(template.patternOverlays ?? {})];
    if (!template.patterns?.length) errors.push(`${template.id}: primary pattern list is empty`);
    for (const patternRef of allowedPatterns) {
      const pattern = patterns.get(patternRef);
      if (!pattern) errors.push(`${template.id}: unknown canonical pattern ${patternRef}`);
      else if (!Array.isArray(pattern.anatomy) || pattern.anatomy.length === 0 || !unique(pattern.anatomy)) {
        errors.push(`${template.id}: pattern ${patternRef} has no unique required region sequence`);
      } else if (JSON.stringify(pattern.anatomy) !== JSON.stringify(catalogs.grammar.regionContracts?.patterns?.[patternRef])) {
        errors.push(`${template.id}: pattern ${patternRef} required-region sequence differs from central composition grammar`);
      }
    }
  }
  for (const pattern of catalogs.patterns) {
    if (!Array.isArray(pattern.anatomy) || pattern.anatomy.length === 0 || !unique(pattern.anatomy)) continue;
    if (JSON.stringify(pattern.anatomy) !== JSON.stringify(catalogs.grammar.regionContracts?.patterns?.[pattern.id])) {
      errors.push(`${pattern.id}: required-region sequence differs from central composition grammar`);
    }
  }
  for (const template of catalogs.templates) {
    if (!Array.isArray(template.regions) || template.regions.length === 0 || !unique(template.regions)) continue;
    if (JSON.stringify(template.regions) !== JSON.stringify(catalogs.grammar.regionContracts?.templates?.[template.id])) {
      errors.push(`${template.id}: required-region sequence differs from central composition grammar`);
    }
  }
  for (const layout of catalogs.layouts) {
    if (!Array.isArray(layout.compatibleTemplateRefs)) errors.push(`${layout.id}: compatibleTemplateRefs must be an array`);
    for (const templateRef of layout.compatibleTemplateRefs ?? []) {
      const template = templates.get(templateRef);
      if (!template) errors.push(`${layout.id}: unknown reciprocal template ${templateRef}`);
      else if (!template.compatibleLayoutRefs?.includes(layout.id)) errors.push(`${layout.id}: template ${templateRef} does not reciprocally list the layout`);
    }
  }
  for (const recipe of catalogs.recipes) {
    const template = templates.get(recipe.templateRef);
    const pattern = patterns.get(recipe.semanticPattern);
    if (!template) errors.push(`${recipe.id}: unknown template ${recipe.templateRef}`);
    else if (!template.recipeRefs?.includes(recipe.id)) errors.push(`${recipe.id}: template ${template.id} does not reciprocally list the recipe`);
    if (!pattern) errors.push(`${recipe.id}: unknown semantic pattern ${recipe.semanticPattern}`);
    else if (template && !(template.patterns ?? []).includes(recipe.semanticPattern) && !Object.hasOwn(template.patternOverlays ?? {}, recipe.semanticPattern)) {
      errors.push(`${recipe.id}: semantic pattern ${recipe.semanticPattern} is not compatible with ${template.id}`);
    }
    if (!recipe.id || !recipe.templateRef || !recipe.semanticPattern) errors.push("recipe is missing its canonical identity, template, or semantic pattern link");
  }
  return errors;
}

export function validateTypedComponentContracts(root = ROOT, componentsOverride = null, reuseAuditOverride = null) {
  const sourcePath = PATHS.components;
  const source = componentsOverride ? null : load(root, sourcePath);
  const components = componentsOverride ?? records(source, "components");
  const audit = reuseAuditOverride ?? load(root, PATHS.reuseAudit);
  const unbound = audit?.publicExportInventory?.unboundFamilies;
  const errors = [];
  if (!Array.isArray(unbound) || unbound.length !== 28 || !unique(unbound)) {
    errors.push("component contract-only denominator must remain the exact 28-family reuse-audit population");
    return errors;
  }
  const componentById = new Map(components.map((item) => [item.id, item]));
  if (componentById.size !== 31 || components.length !== 31) errors.push("component contracts must preserve all 31 existing family records");
  const typeLibrary = load(root, PATHS.componentValueTypes);
  const screenRegistry = load(root, PATHS.canonicalScreens);
  const actionRegistry = load(root, PATHS.canonicalActions);
  const goalsRegistry = load(root, PATHS.canonicalGoals);
  const canonicalViewIds = [...records(screenRegistry, "screens"), ...records(screenRegistry, "laneViews")].map((record) => record.id).sort();
  const registeredRouteIds = records(screenRegistry, "screens").filter((record) => typeof record.route === "string" && record.route).map((record) => record.id).sort();
  const canonicalActionIds = [...records(actionRegistry, "actions"), ...records(actionRegistry, "ownerDefinedActions")].map((record) => record.id).sort();
  const canonicalIntentIds = records(goalsRegistry, "intents").map((record) => record.id).sort();
  if (!typeLibrary || typeLibrary.$schema !== "https://json-schema.org/draft/2020-12/schema" || !typeLibrary.$id || !typeLibrary.$defs) {
    errors.push("closed Media value type registry must be a Draft 2020-12 schema with a stable id and $defs");
  } else {
    try { typedSchemaEngine(root); } catch (error) { errors.push(`Media value type registry is invalid: ${error.message}`); }
    const normativeTypes = typeLibrary.normativeTypeRecords;
    const typeNames = Object.keys(typeLibrary.$defs);
    if (!Array.isArray(normativeTypes) || !unique(normativeTypes.map((record) => record.id))
      || JSON.stringify(normativeTypes.map((record) => record.id).sort())
        !== JSON.stringify(typeNames.map((name) => `media.component-value-type.${name}`).sort())) {
      errors.push("normativeTypeRecords must uniquely enumerate every independently normative closed value type");
    }
    const canonicalValues = load(root, PATHS.canonicalValueObjects)?.canonicalConversionDefinitions?.records ?? [];
    const canonicalTimeIds = new Set(canonicalValues.map((record) => record.id));
    const rationalTimeId = "media.value.rational-media-time";
    const sampleBoundaryId = "media.value.sample-boundary-index";
    const expectedCanonicalEnums = { MediaViewRef: canonicalViewIds, RegisteredMediaReturnRouteRef: registeredRouteIds,
      MediaActionIntentRef: canonicalActionIds, ActionIntentRef: canonicalActionIds, CanonicalIntentRef: canonicalIntentIds };
    const expectedRegistryAuthority = {
      MediaViewRef: [`${PATHS.canonicalScreens}#/screens`, `${PATHS.canonicalScreens}#/laneViews`],
      RegisteredMediaReturnRouteRef: [`${PATHS.canonicalScreens}#/screens`],
      MediaActionIntentRef: [`${PATHS.canonicalActions}#/actions`, `${PATHS.canonicalActions}#/ownerDefinedActions`],
      ActionIntentRef: [`${PATHS.canonicalActions}#/actions`, `${PATHS.canonicalActions}#/ownerDefinedActions`],
      CanonicalIntentRef: [`${PATHS.canonicalGoals}#/intents`],
    };
    for (const record of normativeTypes ?? []) {
      const name = record.id?.slice("media.component-value-type.".length);
      if (!typeLibrary.$defs?.[name] || record.schemaRef !== `${typeLibrary.$id}#/$defs/${name}`
        || record.sourceAuthority !== "Media" || typeof record.description !== "string" || !record.description.trim()) {
        errors.push(`${record.id ?? "normative value type"}: exact schemaRef, Media authority, and source description are required`);
      }
      const requiredTimeAuthorities = name === "HalfOpenRationalInterval" || name === "OptionalHalfOpenRationalInterval"
        ? [rationalTimeId, sampleBoundaryId]
        : name === "SourceSampleTimebaseRef" ? [sampleBoundaryId]
          : ["RationalSourceTime", "RationalTimelineTimebaseRef", "SourceTimebaseRef", "CompositionTimebaseRef"].includes(name) ? [rationalTimeId] : [];
      if (requiredTimeAuthorities.some((id) => !canonicalTimeIds.has(id)
        || !record.authorityRefs?.includes(`${PATHS.canonicalValueObjects}#canonicalConversionDefinitions/records/@id=${id}`))) {
        errors.push(`${record.id}: typed clock source must cite the exact canonical PDP-1 value contract(s)`);
      }
      const canonicalIds = expectedCanonicalEnums[name];
      if (canonicalIds && (JSON.stringify(typeLibrary.$defs[name]?.enum) !== JSON.stringify(canonicalIds)
        || expectedRegistryAuthority[name].some((ref) => !record.authorityRefs?.includes(ref)))) {
        errors.push(`${record.id}: finite identity enum must equal its exact current owner-registry population and cite the source`);
      }
    }
  }
  const typeSchema = (type) => {
    if (type.startsWith("Enum<") && type.endsWith(">")) return { type: "string", enum: type.slice(5, -1).split("|"), description: `Closed enum source values for ${type}.`, examples: [type.slice(5, -1).split("|")[0]] };
    if (type.startsWith("Array<") && type.endsWith(">")) return { type: "array", items: typeSchema(type.slice(6, -1)), description: `Typed array of ${type.slice(6, -1)} values.` };
    if (type.startsWith("ActionIntentRef<") && type.endsWith(">")) return { type: "string", const: type.slice("ActionIntentRef<".length, -1), description: "Exact source-bound action intent identity." };
    return { $ref: `${typeLibrary?.$id}#/$defs/${type}` };
  };
  const componentValidators = new Map();
  for (const componentId of unbound) {
    const component = componentById.get(componentId);
    if (!component) { errors.push(`${componentId}: exact contract-only source record is missing`); continue; }
    const definition = component.typedDefinition;
    const prefix = `${componentId}:`;
    if (!definition) { errors.push(`${prefix} typedDefinition is required for each contract-only family`); continue; }
    if (definition.id !== `${componentId}.typed-definition.v1` || definition.sourceAuthority !== "Media"
      || definition.contractStatus !== "OWNER_DEFINED_TYPED_COMPONENT_CONTRACT; INDEPENDENT_REVIEW_OPEN"
      || definition.runtimeAdmission !== "NOT_ADMITTED") errors.push(`${prefix} typed definition identity, authority, review state, or runtime boundary is invalid`);
    const baseRef = `${sourcePath}#components/@id=${componentId}`;
    const valueTypeRef = `${PATHS.componentValueTypes}#/$defs`;
    if (!Array.isArray(definition.sourceRefs) || !unique(definition.sourceRefs) || !definition.sourceRefs.includes(baseRef) || !definition.sourceRefs.includes(valueTypeRef)) errors.push(`${prefix} exact, unique self and value-type registry source references are required`);
    const props = definition.props;
    const propNames = Array.isArray(props) ? props.map((prop) => prop?.name) : [];
    const sharedProps = ["state", "variant", "actionIntents", "keyboardBehavior"];
    const semanticProps = propNames.slice(0, -sharedProps.length);
    if (!Array.isArray(props) || props.length <= sharedProps.length || !unique(propNames)
      || JSON.stringify(propNames.slice(-sharedProps.length)) !== JSON.stringify(sharedProps)
      || props.some((prop) => typeof prop.name !== "string" || !prop.name.trim()
        || typeof prop.type !== "string" || !prop.type.trim() || /^(?:string|object|unknown|any|mediacomponentvalue)$/iu.test(prop.type.trim())
        || typeof prop.required !== "boolean" || typeof prop.meaning !== "string" || !prop.meaning.trim())) {
      errors.push(`${prefix} typed props must contain family-specific typed data fields followed by state, variant, actionIntents, and keyboardBehavior`);
    }
    if (!Array.isArray(definition.requiredDataProps) || !unique(definition.requiredDataProps)
      || JSON.stringify(definition.requiredDataProps) !== JSON.stringify(semanticProps)) {
      errors.push(`${prefix} semantic field inventory must exactly bind every typed data prop`);
    }
    if (definition.schemaDialect !== "JSON_SCHEMA_2020_12_WITH_MEDIA_COMPONENT_VALUE_TYPES_V1") errors.push(`${prefix} must declare the closed Media value-type schema dialect`);
    if (!Array.isArray(definition.requiredDataProps) || !unique(definition.requiredDataProps)
      || JSON.stringify(definition.requiredDataProps) !== JSON.stringify(semanticProps)) errors.push(`${prefix} semantic field inventory must exactly bind every typed data prop`);
    const inputSchema = definition.inputSchema;
    const schemaProps = inputSchema?.properties;
    const expectedRequired = props.filter((prop) => prop.required).map((prop) => prop.name);
    if (inputSchema?.$schema !== "https://json-schema.org/draft/2020-12/schema" || inputSchema?.type !== "object"
      || inputSchema.additionalProperties !== false || !schemaProps || typeof schemaProps !== "object"
      || JSON.stringify(Object.keys(schemaProps)) !== JSON.stringify(propNames)
      || JSON.stringify(inputSchema.required) !== JSON.stringify(expectedRequired)) {
      errors.push(`${prefix} closed Draft 2020-12 input schema must bind every declared prop, requiredness, and no extras`);
    } else {
      for (const prop of props) {
        const schemaProp = schemaProps[prop.name];
        let expected;
        if (prop.name === "state") expected = { type: "string", enum: component.states };
        else if (prop.name === "variant") expected = { type: "string", enum: component.variants };
        else if (prop.name === "actionIntents") expected = component.actions?.length
          ? { type: "array", items: { type: "string", enum: component.actions }, uniqueItems: true }
          : { type: "array", maxItems: 0 };
        else if (prop.name === "keyboardBehavior") expected = { const: component.keyboard };
        else expected = typeSchema(prop.type);
        if (JSON.stringify(schemaProp) !== JSON.stringify(expected)) errors.push(`${prefix} input schema for ${prop.name} must resolve its exact typed value contract`);
      }
    }
    if (!Array.isArray(definition.allowedStateVariantPairs) || definition.allowedStateVariantPairs.length !== component.states.length
      || new Set(definition.allowedStateVariantPairs.map(({ state, variant }) => `${state}\u0000${variant}`)).size !== definition.allowedStateVariantPairs.length
      || definition.allowedStateVariantPairs.some(({ state, variant }) => !component.states.includes(state) || !component.variants.includes(variant))) {
      errors.push(`${prefix} must explicitly bind every valid state/variant combination without duplicates or unknown values`);
    } else {
      const declaredPairs = definition.allowedStateVariantPairs.map(({ state, variant }) => `${state}\u0000${variant}`).sort();
      const schemaPairs = (inputSchema?.allOf?.[0]?.oneOf ?? []).map((entry) => `${entry.properties?.state?.const}\u0000${entry.properties?.variant?.const}`).sort();
      if (JSON.stringify(declaredPairs) !== JSON.stringify(schemaPairs)) errors.push(`${prefix} executable state/variant constraints must exactly match their authored semantic pair inventory`);
    }
    if (!Array.isArray(definition.invariants) || definition.invariants.length === 0
      || definition.invariants.some((rule) => typeof rule !== "string" || !rule.trim())) errors.push(`${prefix} at least one material family invariant is required`);
    if (!Array.isArray(definition.sourceRefs) || definition.sourceRefs.some((ref) => typeof ref !== "string" || !ref.includes("#"))) errors.push(`${prefix} every source binding must be an exact file anchor`);
    for (const [field, sourceValue] of [["states", component.states], ["variants", component.variants], ["actions", component.actions ?? []]]) {
      if (JSON.stringify(definition[field]) !== JSON.stringify(sourceValue)) errors.push(`${prefix} typed ${field} must exactly equal the current component contract`);
    }
    if (!Array.isArray(definition.errors) || !definition.errors.length
      || !definition.errors.some((error) => error.code === "UNRECOGNIZED_STATE" && typeof error.condition === "string")) errors.push(`${prefix} typed errors must reject unrecognized state input`);
    for (const error of definition.errors ?? []) {
      if (error.state && !component.states.includes(error.state)) errors.push(`${prefix} error state ${error.state} is not a declared component state`);
    }
    if (definition.keyboard?.requirement !== component.keyboard || !/verification remains pending/u.test(definition.keyboard?.status ?? "")) errors.push(`${prefix} keyboard behavior must preserve the source requirement and open verification`);
    for (const nonClaim of ["Shared export", "package consumption", "implementation", "runtime behavior", "rendered conformance", "independent acceptance"]) {
      if (!definition.nonClaims?.includes(nonClaim)) errors.push(`${prefix} typed contract must explicitly disclaim ${nonClaim}`);
    }
    for (const action of component.actions ?? []) {
      const actionRef = `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${action}`;
      if (!definition.sourceRefs?.includes(actionRef)) errors.push(`${prefix} action ${action} needs its exact PDP-3 source ref`);
    }
    for (const prop of props ?? []) {
      const exactAction = /^ActionIntentRef<([^>]+)>$/u.exec(prop.type ?? "")?.[1];
      if (exactAction && (!canonicalActionIds.includes(exactAction)
        || !definition.sourceRefs?.includes(`${PATHS.canonicalActions}#actions/@id=${exactAction}`)
          && !definition.sourceRefs?.includes(`${PATHS.canonicalActions}#ownerDefinedActions/@id=${exactAction}`))) {
        errors.push(`${prefix} exact typed action ${exactAction} must resolve to the current owner action registry and its source anchor`);
      }
    }
    if (inputSchema && typeLibrary) {
      try {
        const validate = compileTypedSchema(root, inputSchema);
        componentValidators.set(componentId, validate);
        if (!definition.positiveFixture || !validate(definition.positiveFixture)) {
          errors.push(`${prefix} positive value fixture must satisfy the executable closed schema${validate.errors ? `: ${JSON.stringify(validate.errors)}` : ""}`);
        }
      } catch (error) {
        errors.push(`${prefix} input schema contains an unresolved or invalid type: ${error.message}`);
      }
    }
  }
  for (const component of components) {
    if (!unbound.includes(component.id) && component.typedDefinition) errors.push(`${component.id}: do not replace one of the three existing public-source dispositions with a contract-only typed definition`);
  }
  if (components.filter((component) => !unbound.includes(component.id) && component.typedDefinition).length !== 0
    || components.filter((component) => !unbound.includes(component.id)).length !== 3) errors.push("the three existing public-source dispositions must remain separate from the 28 Media contract-only definitions");
  return errors;
}

export function validateTypedComponentInstance(componentId, input, root = ROOT, trustedContext = undefined) {
  const componentSource = readYaml(root, PATHS.components);
  const typeSource = readYaml(root, PATHS.componentValueTypes);
  if (!componentSource || !typeSource) return { valid: false, errors: ["typed component source registry is absent"] };
  const sourceRevision = `${componentSource.revision}\u0000${typeSource.revision}`;
  let validators = typedValidatorCache.get(sourceRevision);
  if (!validators) {
    validators = new Map();
    typedValidatorCache.set(sourceRevision, validators);
    const source = componentSource.value;
    const typeLibrary = typeSource.value;
    if (!typeLibrary) return { valid: false, errors: ["closed Media value-type registry is absent"] };
    try {
      for (const component of records(source, "components").filter((record) => record.typedDefinition)) {
        validators.set(component.id, compileTypedSchema(root, component.typedDefinition.inputSchema));
      }
    } catch (error) {
      return { valid: false, errors: [error.message] };
    }
  }
  const validate = validators.get(componentId);
  if (!validate) return { valid: false, errors: [`${componentId}: typed Media contract is absent`] };
  const valid = validate(input);
  const errors = valid ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
  if (valid && componentId === "media.component.identity-context-boundary") {
    const ready = input.handoffState === "context-ready";
    if (input.state !== input.handoffState || input.variant !== input.handoffState) {
      errors.push("handoffState, component state, and variant must identify the same exact disposition");
    }
    const evaluation = input.contextResolution;
    if (!ready) {
      if (input.resolvedWorkspaceRef || evaluation?.evaluatorDisposition === "HOST_ADAPTER_EVIDENCE_ACCEPTABLE_FOR_CONTEXT") {
        errors.push("non-ready identity state cannot carry accepted context or a resolved workspace");
      }
    } else {
      if (!input.identityRequest || !evaluation || !input.resolvedWorkspaceRef) {
        errors.push("context-ready requires a complete PXD-082 request, evaluated result, and exact workspace tuple");
      } else {
        const trusted = trustedContext && typeof trustedContext === "object" && !Array.isArray(trustedContext)
          && Object.keys(trustedContext).every((key) => ["now", "expectedOwnerPin", "registeredReturnRouteIds", "identityRequest"].includes(key))
          && typeof trustedContext.now === "string"
          && trustedContext.expectedOwnerPin && typeof trustedContext.expectedOwnerPin === "object"
          && Array.isArray(trustedContext.registeredReturnRouteIds)
          && trustedContext.identityRequest && typeof trustedContext.identityRequest === "object"
          ? trustedContext : null;
        if (!trusted) {
          errors.push("context-ready requires out-of-band trusted request, evaluation time, owner pin, and host-registered route policy");
        }
        const configuredRoutes = trusted?.registeredReturnRouteIds ?? [];
        const trustedRequest = trusted?.identityRequest;
        const requestValid = validateMediaIdentityHandoffRequest(trustedRequest, configuredRoutes);
        if (!requestValid) errors.push("out-of-band host request does not satisfy the exact Media owner-defined handoff boundary");
        if (JSON.stringify(input.identityRequest) !== JSON.stringify(trustedRequest)
          || JSON.stringify(evaluation.request) !== JSON.stringify(trustedRequest)) {
          errors.push("component and evaluated requests must exactly match the out-of-band host-constructed request");
        }
        const disposition = evaluateMediaIdentityHandoffResult(trustedRequest, evaluation.result, {
          now: trusted?.now,
          registeredReturnRouteIds: configuredRoutes,
          expectedOwnerPin: trusted?.expectedOwnerPin,
        });
        if (disposition !== "HOST_ADAPTER_EVIDENCE_ACCEPTABLE_FOR_CONTEXT"
          || evaluation.evaluatorDisposition !== disposition) errors.push("PXD-082 evaluation must be recomputed and exactly acceptable for current context");
        if (evaluation.evaluatedAt !== trusted?.now
          || JSON.stringify(evaluation.expectedOwnerPin) !== JSON.stringify(trusted?.expectedOwnerPin)) {
          errors.push("component evaluation metadata must match the out-of-band trusted time and owner pin");
        }
        const requestWorkspace = trustedRequest?.mediaRequest?.requestedWorkspaceId;
        const result = evaluation.result;
        if (trustedRequest?.mediaRequest?.registeredReturnRouteId !== input.requestedDestinationRef) {
          errors.push("registered return route identity must be the same exact canonical Media destination view");
        }
        if (!requestWorkspace || requestWorkspace !== input.resolvedWorkspaceRef.workspaceId
          || result.requestedWorkspaceId !== input.resolvedWorkspaceRef.workspaceId
          || result.tenantContextRef !== input.resolvedWorkspaceRef.tenantId
          || result.tenantContextRef !== trustedRequest?.hostContext?.tenantContextRef) {
          errors.push("resolved workspace, requested workspace, result tenant, and trusted request tenant must be the same exact tuple");
        }
        if (evaluation.result.outcome !== "AUTHORIZED") errors.push("only an authorized PXD-082 outcome may establish ready context");
      }
    }
  }
  if (valid && componentId) {
    const source = load(root, PATHS.components);
    const component = records(source, "components").find((record) => record.id === componentId);
    const typeLibrary = load(root, PATHS.componentValueTypes);
    validateExactTypedSemantics(component?.typedDefinition?.inputSchema, input, typeLibrary, "", errors, new Set(), root);
  }
  return { valid: errors.length === 0, errors };
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const parseBoundedDecimal = (value, min = 1n, max = INT64_MAX) => {
  if (typeof value !== "string" || value.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = BigInt(value);
  return parsed < min || parsed > max ? null : parsed;
};
function validateExactTypedSemantics(schema, value, library, path, errors, visited = new Set(), root = ROOT) {
  if (!schema || value === null || value === undefined) return;
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith(`${library?.$id}#/$defs/`)) {
    const name = ref.slice(`${library.$id}#/$defs/`.length);
    const target = library.$defs?.[name];
    if (!target || visited.has(`${name}:${path}`)) return;
    const next = new Set(visited).add(`${name}:${path}`);
    if (typeof value === "string") {
      const registry = name === "MediaViewRef" ? load(root, PATHS.canonicalScreens)
        : name === "RegisteredMediaReturnRouteRef" ? load(root, PATHS.canonicalScreens)
          : ["MediaActionIntentRef", "ActionIntentRef"].includes(name) ? load(root, PATHS.canonicalActions)
            : name === "CanonicalIntentRef" ? load(root, PATHS.canonicalGoals) : null;
      const canonicalIds = name === "MediaViewRef" ? [...records(registry, "screens"), ...records(registry, "laneViews")].map((record) => record.id)
        : name === "RegisteredMediaReturnRouteRef" ? records(registry, "screens").filter((record) => typeof record.route === "string" && record.route).map((record) => record.id)
          : ["MediaActionIntentRef", "ActionIntentRef"].includes(name) ? [...records(registry, "actions"), ...records(registry, "ownerDefinedActions")].map((record) => record.id)
            : name === "CanonicalIntentRef" ? records(registry, "intents").map((record) => record.id) : null;
      if (canonicalIds && !canonicalIds.includes(value)) errors.push(`${path || "/"}: ${name} must reference an exact current owner-registry identity`);
    }
    if (name === "RationalSourceTime" && value && typeof value === "object") {
      const ticks = parseBoundedDecimal(value.ticks, INT64_MIN, INT64_MAX);
      const numerator = parseBoundedDecimal(value.secondsPerTick?.numerator);
      const denominator = parseBoundedDecimal(value.secondsPerTick?.denominator);
      if (ticks === null) errors.push(`${path || "/"}: rational clock ticks must be exact signed-64-bit decimal strings`);
      if (numerator === null || denominator === null) errors.push(`${path || "/"}: rational source timebase must have positive signed-64-bit numerator and denominator`);
    }
    if (["RationalTimelineTimebaseRef", "SourceTimebaseRef", "CompositionTimebaseRef"].includes(name) && value && typeof value === "object") {
      const numerator = parseBoundedDecimal(value.secondsPerTick?.numerator);
      const denominator = parseBoundedDecimal(value.secondsPerTick?.denominator);
      const originTicks = parseBoundedDecimal(value.originTicks, INT64_MIN, INT64_MAX);
      if (numerator === null || denominator === null) errors.push(`${path || "/"}: declared timebase must use positive signed-64-bit rational seconds per tick`);
      if (originTicks === null) errors.push(`${path || "/"}: declared timebase origin must be exact signed-64-bit decimal ticks`);
    }
    if (name === "HalfOpenRationalInterval" && value?.start && value?.end) {
      const start = value.start, end = value.end;
      const startTicks = parseBoundedDecimal(start.ticks, INT64_MIN, INT64_MAX);
      const endTicks = parseBoundedDecimal(end.ticks, INT64_MIN, INT64_MAX);
      const sn = parseBoundedDecimal(start.secondsPerTick?.numerator), sd = parseBoundedDecimal(start.secondsPerTick?.denominator);
      const en = parseBoundedDecimal(end.secondsPerTick?.numerator), ed = parseBoundedDecimal(end.secondsPerTick?.denominator);
      if (start.clockKind !== end.clockKind || start.clockId !== end.clockId || start.streamId !== end.streamId) {
        errors.push(`${path || "/"}: interval endpoints must use the same exact clock, stream, and domain`);
      } else if ([startTicks, endTicks, sn, sd, en, ed].some((part) => part === null)) {
        errors.push(`${path || "/"}: interval requires bounded exact rational endpoint values`);
      } else {
        try {
          const alignedEnd = convertMediaTime(
            { ...end, ticks: endTicks, timeBase: { numerator: en, denominator: ed } },
            { clockKind: start.clockKind, clockId: start.clockId, streamId: start.streamId, timeBase: { numerator: sn, denominator: sd }, rounding: "exact" },
          ).timestamp.ticks;
          if (alignedEnd <= startTicks) errors.push(`${path || "/"}: half-open interval end must be strictly greater than start`);
        } catch {
          errors.push(`${path || "/"}: canonical PDP-1 exact clock conversion rejected interval alignment`);
        }
      }
    }
    if (name === "RightsConsentScope" && value?.tenantId && value?.subjectVersionRef?.tenantId !== value.tenantId) {
      errors.push(`${path || "/"}: rights/consent subject version tenant must exactly match its enclosing decision scope`);
    }
    if (name === "OrderedScene" && value?.sceneRef?.tenantId
      && (value.sourceVersionRefs ?? []).some((version) => version.tenantId !== value.sceneRef.tenantId)) {
      errors.push(`${path || "/"}: every ordered-scene source version must share its exact scene tenant scope`);
    }
    if (name === "VersionedTransitionSpec" && value?.fromSceneRef?.tenantId
      && value.toSceneRef?.tenantId !== value.fromSceneRef.tenantId) {
      errors.push(`${path || "/"}: transition endpoints must share the exact tenant-scoped scene identity context`);
    }
    validateExactTypedSemantics(target, value, library, path, errors, next, root);
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    for (const option of schema.anyOf) {
      try { if (compileTypedSchema(root, option)(value)) validateExactTypedSemantics(option, value, library, path, errors, visited, root); } catch { /* parent JSON Schema validation reports invalid branches */ }
    }
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    for (const option of schema.oneOf) {
      try { if (compileTypedSchema(root, option)(value)) validateExactTypedSemantics(option, value, library, path, errors, visited, root); } catch { /* parent JSON Schema validation reports invalid branches */ }
    }
    return;
  }
  if (schema.type === "array" && Array.isArray(value)) {
    value.forEach((item, index) => validateExactTypedSemantics(schema.items, item, library, `${path}/${index}`, errors, visited, root));
  }
  if (schema.type === "object" && value && typeof value === "object") {
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      validateExactTypedSemantics(childSchema, value[key], library, `${path}/${key}`, errors, visited, root);
    }
  }
}

export function validateComposition(contract, catalogs, componentOverrides = null) {
  const errors = [];
  const templateById = new Map(catalogs.templates.map((item) => [item.id, item]));
  const layoutById = new Map(catalogs.layouts.map((item) => [item.id, item]));
  const patternById = new Map(catalogs.patterns.map((item) => [item.id, item]));
  const actionById = new Map(catalogs.actions.map((item) => [item.id, item]));
  const componentById = componentOverrides ?? new Map(catalogs.components.map((item) => [item.id, item]));
  const template = templateById.get(contract?.templateId);
  if (!template) errors.push(`unknown template ${contract?.templateId}`);
  if (contract?.templateContract?.templateRef !== contract?.templateId) errors.push("templateContract.templateRef must reciprocally equal templateId");
  if (template && JSON.stringify(template.regions) !== JSON.stringify(catalogs.grammar?.regionContracts?.templates?.[template.id])) errors.push(`template ${template.id} required-region sequence differs from central composition grammar`);

  if (!Array.isArray(contract?.layoutIds) || contract.layoutIds.length === 0 || !unique(contract.layoutIds)) errors.push("layoutIds must be a nonempty unique canonical reference list");
  for (const id of contract?.layoutIds ?? []) {
    const layout = layoutById.get(id);
    if (!layout) errors.push(`unknown layout ${id}`);
    else if (!template?.compatibleLayoutRefs?.includes(id) || !layout.compatibleTemplateRefs?.includes(template.id)) errors.push(`template/layout link is not reciprocal for ${template.id} and ${id}`);
  }

  const patternIds = contract?.patternIds;
  const patternOverlayIds = contract?.patternOverlayIds ?? [];
  if (!Array.isArray(patternIds) || patternIds.length === 0 || !unique(patternIds)) errors.push("patternIds must be a nonempty unique list");
  if (!Array.isArray(patternOverlayIds) || !unique(patternOverlayIds)) errors.push("patternOverlayIds must be a unique list when present");
  const selectedPatternIds = [...(patternIds ?? []), ...(patternOverlayIds ?? [])];
  if (!unique(selectedPatternIds)) errors.push("a pattern cannot be selected as both primary and overlay");
  const selectedPatterns = selectedPatternIds.map((id) => patternById.get(id)).filter(Boolean);
  for (const id of selectedPatternIds) {
    const pattern = patternById.get(id);
    if (!pattern) errors.push(`unknown pattern ${id}`);
    else if (template && !(template.patterns ?? []).includes(id) && !Object.hasOwn(template.patternOverlays ?? {}, id)) errors.push(`pattern ${id} is not a primary pattern or approved overlay for ${template.id}`);
    else if (template && (patternOverlayIds ?? []).includes(id) && !Object.hasOwn(template.patternOverlays ?? {}, id)) errors.push(`patternOverlayIds entry ${id} is not an approved overlay for ${template.id}`);
  }

  const selectedComponentIds = new Set(contract?.componentIds ?? contract?.componentRefs ?? []);
  for (const pattern of selectedPatterns) {
    if (!Array.isArray(pattern.anatomy) || pattern.anatomy.length === 0 || !unique(pattern.anatomy)) errors.push(`pattern ${pattern.id} has no unique required anatomy regions`);
    else if (JSON.stringify(pattern.anatomy) !== JSON.stringify(catalogs.grammar?.regionContracts?.patterns?.[pattern.id])) errors.push(`pattern ${pattern.id} required-region sequence differs from central composition grammar`);
    if (Array.isArray(pattern.componentRefs)) {
      for (const componentId of pattern.componentRefs) selectedComponentIds.add(componentId);
    } else if (!(pattern.componentDisposition === "SHARED_PRIMITIVES_ONLY" && typeof pattern.noMediaComponentRationale === "string" && pattern.noMediaComponentRationale.trim())) {
      errors.push(`pattern ${pattern.id} needs component bindings or an explicit Shared-primitives-only disposition`);
    }
  }

  if (!Array.isArray(contract?.anatomy) || contract.anatomy.length === 0 || !unique(contract.anatomy)) errors.push("screen anatomy must be a nonempty unique sequence");
  for (const componentId of selectedComponentIds) {
    const component = componentById.get(componentId);
    if (!component) errors.push(`unknown component ${componentId}`);
    else {
      if (!Array.isArray(component.anatomy) || component.anatomy.length === 0) errors.push(`component ${componentId} has no anatomy regions`);
      if (typeof component.keyboard !== "string" || !component.keyboard.trim()) errors.push(`component ${componentId} lacks keyboard semantics`);
      if (typeof component.accessibility !== "string" || !component.accessibility.trim()) errors.push(`component ${componentId} lacks accessibility semantics`);
    }
  }

  const focusRule = catalogs.grammar?.accessibilityRules?.screenFocus;
  if (typeof focusRule !== "string" || !/focus/iu.test(focusRule) || !/reading[- ]order/iu.test(focusRule)) errors.push("central screen accessibility grammar must preserve focus and reading order");
  if (contract?.accessibility && typeof contract.accessibility === "object" && contract.accessibility.status !== "accessibility-intent-proposal-pending-owner-review") errors.push("screen accessibility intent must remain explicitly proposal-level");

  const actionIds = contract?.actions ?? [];
  if (!Array.isArray(actionIds) || !unique(actionIds)) errors.push("actions must be a unique canonical action reference list");
  for (const actionId of actionIds) if (!actionById.has(actionId)) errors.push(`unknown action ${actionId}`);
  for (const consequence of contract?.actionConsequences ?? []) {
    if (!actionById.has(consequence.actionId)) errors.push(`unknown consequence action ${consequence.actionId}`);
    if (!actionIds.includes(consequence.actionId)) errors.push(`consequence action ${consequence.actionId} is absent from actions`);
  }

  const uncertainActions = actionIds.map((id) => actionById.get(id)).filter((action) => {
    const finality = action?.actionDefinitionSemantics?.typedDefinition?.finality ?? action?.finality ?? "";
    return /unknown|uncertain|pending|acknowledgment-required/iu.test(finality);
  });
  if (uncertainActions.length && template) {
    const exposesUnknownRecovery = selectedPatterns.some((pattern) =>
      (pattern.states ?? []).some((state) => /unknown/iu.test(state))
      && (pattern.anatomy ?? []).some((region) => /recovery|outcome|finality/iu.test(region))
      && ((pattern.componentRefs?.length ?? 0) > 0 || (pattern.componentDisposition === "SHARED_PRIMITIVES_ONLY" && typeof pattern.noMediaComponentRationale === "string" && pattern.noMediaComponentRationale.trim())));
    if (!exposesUnknownRecovery) errors.push(`template ${template.id} lacks an approved required region for unknown finality and recovery`);
  }

  const responsive = contract?.responsiveBehavior ?? {};
  const responsiveRef = responsive.ref ?? responsive.reference ?? responsive.sourceRef;
  if (responsiveRef !== ".product-experience/pdp-2-design-interface-system/gui/layout.yaml#layoutRules.responsive") errors.push("responsive behavior must reference the central Media layout grammar");
  if (!Array.isArray(responsive.screenOverrides ?? []) || (responsive.screenOverrides ?? []).length) errors.push("screen-local responsive overrides cannot replace central layout semantics");
  if (contract?.verification?.status === "passed" || contract?.validation?.status === "validated") errors.push("candidate source contract cannot claim screen admission");
  return errors;
}

export function validateAllScreenCompositionSources(root = ROOT) {
  const catalogs = loadCompositionCatalogs(root);
  const errors = [...validateCatalogRelations(catalogs), ...validateTypedComponentContracts(root)];
  const registry = load(root, PATHS.screenRegistry);
  if (!registry || !Array.isArray(registry.screens) || !Array.isArray(registry.laneViews)) return [...errors, "PDP-3 screen registry is missing its screen/lane-view populations"];
  const entries = [...registry.screens, ...registry.laneViews];
  if (entries.length !== 47 || !unique(entries.map((entry) => entry.id))) errors.push("canonical screen composition denominator must remain exactly 47 unique view identities");
  for (const entry of entries) {
    if (!Array.isArray(entry.contractRefs) || entry.contractRefs.length !== 1) { errors.push(`${entry.id}: exactly one canonical screen contract is required`); continue; }
    const contractPath = `${PATHS.screenContracts.replace(/\/[^/]+$/u, "")}/${entry.contractRefs[0]}`;
    const contract = load(root, contractPath);
    if (!contract) { errors.push(`${entry.id}: missing screen contract ${contractPath}`); continue; }
    if (contract.screenId !== entry.id) errors.push(`${entry.id}: screen contract identity mismatch`);
    for (const reason of validateComposition(contract, catalogs)) errors.push(`${entry.id}: ${reason}`);
  }
  return errors;
}

export function validateScreenCompositionContract(contractPath, root = ROOT) {
  const catalogs = loadCompositionCatalogs(root);
  const contract = load(root, contractPath);
  if (!contract) return [`missing screen contract ${contractPath}`];
  return [...validateCatalogRelations(catalogs), ...validateComposition(contract, catalogs)];
}

export const compositionPaths = PATHS;
