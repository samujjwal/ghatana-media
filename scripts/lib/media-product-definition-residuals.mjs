import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectionSources = [
  {
    phase: "PDP-0",
    name: "product-definition",
    path: ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json",
  },
  {
    phase: "PDP-2",
    name: "experience-language",
    path: ".product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json",
  },
  {
    phase: "PDP-3",
    name: "experience-specification",
    path: ".product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json",
  },
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function topLevelSection(source, key) {
  const marker = new RegExp(`^${key}:\\s*$`, "mu");
  const match = marker.exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const tail = source.slice(start);
  const next = /^\S[^\n]*:\s*$/mu.exec(tail);
  return tail.slice(0, next?.index ?? tail.length);
}

function indentedSection(source, key, indent = 2) {
  const marker = new RegExp(`^\\s{${indent}}${key}:\\s*$`, "mu");
  const match = marker.exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const tail = source.slice(start);
  const next = new RegExp(`^\\s{${indent}}[^\\s][^\\n]*:\\s*$`, "mu").exec(tail);
  return tail.slice(0, next?.index ?? tail.length);
}

function numericField(source, key, indent = 2) {
  const expression = new RegExp(`^\\s{${indent}}${key}:\\s*(\\d+)\\s*$`, "mu");
  const value = source.match(expression)?.[1];
  return value === undefined ? null : Number(value);
}

function inlineArray(source, key) {
  const expression = new RegExp(`^\\s{2}${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "mu");
  const contents = source.match(expression)?.[1];
  if (contents === undefined || !contents.trim()) return [];
  return contents.split(",").map((value) => value.trim().replace(/^['"]|['"]$/gu, ""));
}

function parseInlineArray(value) {
  if (value === undefined || !value.trim()) return [];
  return value.split(",").map((entry) => entry.trim().replace(/^['"]|['"]$/gu, "")).filter(Boolean);
}

function declaredInlineArray(source, key, indent = 4) {
  const expression = new RegExp(`^\\s{${indent}}${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "mu");
  return parseInlineArray(source.match(expression)?.[1]);
}

function nestedInlineArrays(source, sectionName, indent = 4) {
  const section = indentedSection(source, sectionName, indent);
  const arrays = [];
  for (const match of section.matchAll(/^\s{6}[^:\n]+:\s*\[([^\]]*)\]\s*$/gmu)) {
    arrays.push(...parseInlineArray(match[1]));
  }
  return [...new Set(arrays)].sort();
}

function unresolvedValues(source) {
  const inline = source.match(/^\s{4}unresolved:\s*\[([^\]]*)\]\s*$/mu)?.[1];
  if (inline !== undefined) return parseInlineArray(inline);
  const section = indentedSection(source, "unresolved", 4);
  const values = [];
  for (const match of section.matchAll(/^\s{6}([^:\n]+):\s*\[([^\]]*)\]\s*$/gmu)) {
    const prefix = match[1].trim();
    values.push(...parseInlineArray(match[2]).map((value) => `${prefix}.${value}`));
  }
  return values.sort();
}

function listPins(source) {
  return [...source.matchAll(/^- path: ([^\n]+)\n  sha256: ([a-f0-9]{64})/gmu)]
    .map((match) => ({ path: match[1].trim(), sha256: match[2] }));
}

function objectField(source, key) {
  const expression = new RegExp(`^\\s{4}${key}:\\s*\\{([^}]+)\\}`, "mu");
  const raw = source.match(expression)?.[1];
  if (raw === undefined) return null;
  return Object.fromEntries(raw.split(",").flatMap((entry) => {
    const match = entry.trim().match(/^([A-Za-z][A-Za-z0-9]*):\s*(\d+)$/u);
    return match ? [[match[1], Number(match[2])]] : [];
  }));
}

function validatePins(root, pins, sourceName, diagnostics) {
  return pins.map((pin) => {
    let current;
    try {
      current = sha256(readFileSync(join(root, pin.path)));
    } catch {
      diagnostics.push(`${sourceName} pin is missing: ${pin.path}`);
      return { ...pin, current: false, state: "MISSING" };
    }
    const currentPin = current === pin.sha256;
    return { ...pin, current: currentPin, state: currentPin ? "CURRENT" : "STALE" };
  });
}

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readText(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function resolveTopLevelSchema(schema) {
  let current = schema;
  const visited = new Set();
  while (typeof current?.$ref === "string") {
    const reference = current.$ref;
    if (!reference.startsWith("#/")) throw new Error(`unsupported top-level schema reference: ${reference}`);
    if (visited.has(reference)) throw new Error(`recursive top-level schema reference: ${reference}`);
    visited.add(reference);
    current = reference.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((value, part) => value?.[part], schema);
    if (!current || typeof current !== "object") throw new Error(`schema reference does not resolve: ${reference}`);
  }
  return current;
}

export function validateProjectionFieldCoverage(root, source, projection) {
  const diagnostics = [];
  const schemaPath = projection.validation?.schemaContract;
  if (typeof schemaPath !== "string" || !schemaPath.trim()) {
    return [`${source.phase} projection has no public schema contract path`];
  }

  let schema;
  let schemaTarget;
  try {
    schema = readJson(root, schemaPath);
    schemaTarget = resolveTopLevelSchema(schema);
  } catch (error) {
    return [`${source.phase} public schema inventory cannot be read: ${error instanceof Error ? error.message : String(error)}`];
  }

  if (projection.validation?.schemaId !== schema.$id) {
    diagnostics.push(`${source.phase} generated schema ID does not match the current public schema`);
  }
  const schemaProperties = schemaTarget.properties ?? {};
  const expectedFields = Object.keys(schemaProperties);
  const expectedFieldSet = new Set(expectedFields);
  const requiredFields = new Set(schemaTarget.required ?? []);
  const generatedInventory = projection.projectionFieldInventory;
  const generatedInventoryFields = Array.isArray(generatedInventory?.fields)
    ? generatedInventory.fields.map(({ name, required }) => `${name}:${required}`)
    : [];
  const currentInventoryFields = expectedFields.map((name) => `${name}:${requiredFields.has(name)}`);
  if (generatedInventory?.schemaId !== schema.$id
    || JSON.stringify(generatedInventoryFields) !== JSON.stringify(currentInventoryFields)) {
    diagnostics.push(`${source.phase} generated public schema field inventory is stale or incomplete`);
  }

  const candidateModel = projection.candidateModel ?? {};
  const fieldSources = projection.candidateFieldSources ?? {};
  const fieldDispositions = projection.candidateMappingReview?.fieldDispositions ?? {};
  const blockers = new Set((projection.fieldMappingBlockers ?? [])
    .filter((blocker) => {
      const disposition = fieldDispositions[blocker?.field];
      const hasReason = Array.isArray(blocker?.reasons)
        && blocker.reasons.some((reason) => typeof reason === "string" && reason.trim());
      return typeof blocker?.field === "string"
        && typeof blocker.status === "string"
        && blocker.status === disposition?.status
        && blocker.sourceDisposition === disposition?.source
        && typeof disposition?.source === "string"
        && disposition.source.trim()
        && hasReason;
    })
    .map(({ field }) => field));
  const explicitEmptySources = projection.candidateMappingReview?.emptyCollectionDispositions ?? {};
  const timestampsDisposition = fieldDispositions.timestamps;

  for (const field of expectedFields) {
    const mapping = fieldSources[field];
    if (!mapping || typeof mapping.mapping !== "string" || !mapping.mapping.trim()) {
      diagnostics.push(`${source.phase} public schema field has no candidate field source: ${field}`);
    }

    const disposition = fieldDispositions[field]
      ?? (["createdAt", "updatedAt"].includes(field) ? timestampsDisposition : undefined);
    if (!disposition?.status || !disposition?.source) {
      diagnostics.push(`${source.phase} public schema field has no mapping disposition: ${field}`);
    }

    if (!Object.hasOwn(candidateModel, field)) {
      const intentionallyOmittedOptionalField = !requiredFields.has(field)
        && disposition?.status === "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY"
        && /omitted intentionally/iu.test(mapping?.mapping ?? "");
      if (requiredFields.has(field) || !intentionallyOmittedOptionalField) {
        diagnostics.push(`${source.phase} public schema field is omitted from candidateModel without an explicit optional omission disposition: ${field}`);
      }
    } else if (Array.isArray(candidateModel[field]) && candidateModel[field].length === 0
      && !blockers.has(field)
      && !(explicitEmptySources[field]?.status === "EMPTY_SOURCE_SET_CONFIRMED" && explicitEmptySources[field]?.source)) {
      diagnostics.push(`${source.phase} empty candidate collection has no blocker or explicit empty-source disposition: ${field}`);
    }
  }

  for (const field of Object.keys(candidateModel)) {
    if (!expectedFieldSet.has(field)) diagnostics.push(`${source.phase} candidateModel field is absent from the public schema: ${field}`);
  }
  for (const field of Object.keys(fieldSources)) {
    if (!expectedFieldSet.has(field)) diagnostics.push(`${source.phase} candidate field source is absent from the public schema: ${field}`);
  }
  for (const field of Object.keys(fieldDispositions)) {
    if (!expectedFieldSet.has(field) && field !== "timestamps") {
      diagnostics.push(`${source.phase} mapping disposition is absent from the public schema: ${field}`);
    }
  }
  for (const blocker of projection.fieldMappingBlockers ?? []) {
    const field = blocker?.field;
    if (!expectedFieldSet.has(field)) {
      diagnostics.push(`${source.phase} blocker is absent from the public schema: ${field}`);
      continue;
    }
    const disposition = fieldDispositions[field];
    if (blocker.status !== disposition?.status) {
      diagnostics.push(`${source.phase} blocker status does not match its field disposition: ${field}`);
    }
    if (blocker.sourceDisposition !== disposition?.source) {
      diagnostics.push(`${source.phase} blocker source does not match its field disposition: ${field}`);
    }
    if (!Array.isArray(blocker.reasons)
      || !blocker.reasons.some((reason) => typeof reason === "string" && reason.trim())) {
      diagnostics.push(`${source.phase} blocker has no substantive reason: ${field}`);
    }
  }
  for (const field of Object.keys(explicitEmptySources)) {
    if (!expectedFieldSet.has(field)) diagnostics.push(`${source.phase} empty-source disposition is absent from the public schema: ${field}`);
  }
  return diagnostics;
}

export function validateProjectionSourceReferences(root, source, projection) {
  const diagnostics = [];
  const sourceAuthorities = new Map((projection.sourceAuthorities ?? []).map((authority) => [authority.sourceRef, authority]));
  for (const [field, mapping] of Object.entries(projection.candidateFieldSources ?? {})) {
    const sourceRef = mapping?.sourceRef;
    if (sourceRef === null || sourceRef === undefined) continue;
    if (typeof sourceRef !== "string" || !sourceRef.trim()) {
      diagnostics.push(`${source.phase} ${field} has an invalid sourceRef`);
      continue;
    }
    if (!sourceRef.startsWith(".") && !sourceRef.startsWith("docs/")) continue;

    const authority = sourceAuthorities.get(sourceRef);
    if (!authority) {
      diagnostics.push(`${source.phase} ${field} sourceRef is not present in sourceAuthorities: ${sourceRef}`);
      continue;
    }
    if (typeof mapping.sourcePath !== "string" || !mapping.sourcePath.trim()) {
      diagnostics.push(`${source.phase} ${field} has no exact sourcePath for ${sourceRef}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(authority.sha256 ?? "")) {
      diagnostics.push(`${source.phase} ${field} source authority has no valid SHA-256: ${sourceRef}`);
      continue;
    }
    try {
      const currentSha256 = sha256(readText(root, sourceRef));
      if (currentSha256 !== authority.sha256) {
        diagnostics.push(`${source.phase} ${field} source authority is stale: ${sourceRef}`);
      }
    } catch {
      diagnostics.push(`${source.phase} ${field} source authority is missing: ${sourceRef}`);
    }
  }
  return diagnostics;
}

function projectionReport(root, source, diagnostics) {
  const projection = readJson(root, source.path);
  diagnostics.push(...validateProjectionSourceReferences(root, source, projection));
  diagnostics.push(...validateProjectionFieldCoverage(root, source, projection));
  const fieldSources = projection.candidateFieldSources ?? {};
  const dispositions = projection.candidateMappingReview?.fieldDispositions ?? {};
  const blockers = projection.fieldMappingBlockers ?? [];
  const emptyCollections = Object.entries(projection.candidateModel ?? {})
    .filter(([, value]) => Array.isArray(value) && value.length === 0)
    .map(([field]) => ({ field, declaredBlocker: blockers.some((blocker) => blocker.field === field) }));
  const blockerFields = new Set();
  const residualFields = [];
  const ownerReviewPendingFields = [];
  const intentionalOmissions = [];
  const timestampOmission = dispositions.timestamps;
  const timestampsAreIntentionallyOmitted = timestampOmission?.status === "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY"
    && !Object.hasOwn(projection.candidateModel ?? {}, "createdAt")
    && !Object.hasOwn(projection.candidateModel ?? {}, "updatedAt")
    && ["createdAt", "updatedAt"].every((field) => fieldSources[field]?.sourceRef === null
      && /optional authored metadata omitted intentionally/iu.test(fieldSources[field]?.mapping ?? ""));

  for (const [field, mapping] of Object.entries(fieldSources)) {
    if (!mapping || typeof mapping.mapping !== "string" || !mapping.mapping.trim()) {
      diagnostics.push(`${source.phase} ${field} has no explicit source-mapping explanation`);
    }
    const groupedTimestampOmission = timestampsAreIntentionallyOmitted && (field === "createdAt" || field === "updatedAt");
    const disposition = dispositions[field] ?? (groupedTimestampOmission ? timestampOmission : undefined);
    if (!disposition?.status || !disposition?.source) {
      diagnostics.push(`${source.phase} ${field} has no exact field disposition and source`);
    }
    if (groupedTimestampOmission) {
      intentionalOmissions.push({ field, status: disposition.status, source: disposition.source });
    }
    if (/OWNER_ACCEPTANCE_PENDING|OWNER_REVIEW_PENDING|OWNER_DECISION_OPEN|PENDING/iu.test(disposition?.status ?? "")) {
      ownerReviewPendingFields.push(field);
    }
  }

  for (const blocker of blockers) {
    if (!blocker?.field || blockerFields.has(blocker.field)) {
      diagnostics.push(`${source.phase} has a malformed or duplicate projection blocker`);
      continue;
    }
    blockerFields.add(blocker.field);
    const disposition = dispositions[blocker.field];
    if (!disposition?.status || blocker.status !== disposition.status) {
      diagnostics.push(`${source.phase} ${blocker.field} blocker does not match its field disposition`);
    }
    if (blocker.sourceDisposition !== disposition?.source) {
      diagnostics.push(`${source.phase} ${blocker.field} blocker source does not match its field disposition`);
    }
    if (!Array.isArray(blocker.reasons)
      || !blocker.reasons.some((reason) => typeof reason === "string" && reason.trim())) {
      diagnostics.push(`${source.phase} ${blocker.field} blocker has no reason`);
    }
    residualFields.push({
      id: `media.${source.name}.field.${blocker.field}`,
      field: blocker.field,
      status: blocker.status,
      source: disposition?.source ?? blocker.sourceDisposition ?? null,
      reasons: blocker.reasons ?? [],
    });
  }

  for (const field of Object.keys(dispositions)) {
    if (!Object.hasOwn(fieldSources, field)
      && !(field === "timestamps" && timestampsAreIntentionallyOmitted)) {
      diagnostics.push(`${source.phase} disposition has no field source: ${field}`);
    }
  }

  residualFields.sort((left, right) => left.field.localeCompare(right.field));
  ownerReviewPendingFields.sort();
  intentionalOmissions.sort((left, right) => left.field.localeCompare(right.field));
  return {
    phase: source.phase,
    name: source.name,
    path: source.path,
    projectionKind: projection.projectionKind,
    projectionStatus: projection.projectionStatus,
    schemaFieldCount: projection.projectionFieldInventory?.fields?.length ?? 0,
    mappedFieldCount: Object.keys(fieldSources).length,
    unresolvedFieldCount: residualFields.length,
    unresolvedFields: residualFields,
    ownerReviewPendingFieldCount: ownerReviewPendingFields.length,
    ownerReviewPendingFields,
    intentionalOmissions,
    emptyCollections,
    ownerDecisionStatus: projection.candidateMappingReview?.ownerDecisionStatus ?? null,
  };
}

function capabilityCoverageReport(root, diagnostics) {
  const path = ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml";
  const source = readText(root, path);
  const leafSection = source.split(/^leaves:\s*$/mu)[1] ?? "";
  const leafBlocks = leafSection.split(/(?=^- id: media\.)/mu).filter((block) => block.startsWith("- id:"));
  const dispositions = {};
  const unresolvedLeafIds = [];
  const unresolvedLeaves = [];
  const classifiedLeaves = [];
  const excludedLeaves = [];

  for (const block of leafBlocks) {
    const id = block.match(/^- id: ([^\n]+)/mu)?.[1];
    const decision = block.match(/^  coverageDecision:\n([\s\S]*?)(?=^  [A-Za-z][A-Za-z0-9]*:|$)/mu)?.[1] ?? "";
    const disposition = decision.match(/^    disposition: ([A-Z_]+)/mu)?.[1] ?? "UNRESOLVED";
    const rationale = decision.match(/^    rationale: ([^\n]+)/mu)?.[1]?.trim() ?? "No coverage rationale is authored.";
    const record = {
      id: id ?? null,
      disposition,
      status: decision.match(/^    status: ([^\n]+)/mu)?.[1]?.trim() ?? "UNRESOLVED",
      sourceRef: block.match(/^  sourceRef: ([^\n]+)/mu)?.[1]?.trim() ?? null,
      rationale,
      missingDecision: block.match(/^    missingDecision: ([^\n]*(?:\n      [^\n]*)?)/mu)?.[1]?.replace(/\n\s+/gu, " ").trim() ?? null,
    };
    dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
    if (disposition === "UNRESOLVED" && id) {
      unresolvedLeafIds.push(id);
      unresolvedLeaves.push(record);
    } else if (disposition === "EXCLUDED_BY_PRODUCT_POLICY") {
      excludedLeaves.push(record);
    } else {
      classifiedLeaves.push(record);
    }
    if (!id) diagnostics.push(`${path} contains a leaf without an ID`);
  }

  const declared = topLevelSection(source, "denominatorReconciliation");
  const declaredLeafCount = numericField(declared, "capabilityLeaves");
  const declaredUnresolved = numericField(declared, "unresolvedCoverageDispositions");
  if (leafBlocks.length !== declaredLeafCount) diagnostics.push(`${path} parsed ${leafBlocks.length} leaves; declared ${declaredLeafCount}`);
  if ((dispositions.UNRESOLVED ?? 0) !== declaredUnresolved) diagnostics.push(`${path} unresolved dispositions do not match its denominator reconciliation`);
  const declaredDispositionFields = {
    JOURNEY_STEP: "journeyStepDispositions",
    MACHINE_OPERATION: "machineOperationDispositions",
    PLATFORM_DEPENDENCY: "platformDependencyDispositions",
  };
  for (const [disposition, field] of Object.entries(declaredDispositionFields)) {
    const declaredCount = numericField(declared, field);
    const actualCount = dispositions[disposition] ?? 0;
    if (declaredCount !== null && declaredCount !== actualCount) diagnostics.push(`${path} ${disposition} dispositions do not match its denominator reconciliation`);
  }

  const pins = listPins(topLevelSection(source, "sourceInventory"));
  if (!pins.length) diagnostics.push(`${path} has no source inventory pins`);
  return {
    source: path,
    leafCount: leafBlocks.length,
    applicability: {
      total: leafBlocks.length,
      classified: classifiedLeaves.length,
      unresolved: unresolvedLeafIds.length,
      excludedWithRationale: excludedLeaves,
      source: `${path}#/leaves/*/coverageDecision`,
    },
    acceptedCoverageCount: classifiedLeaves.filter((leaf) => /(^|[;, ])accepted([;, ]|$)/iu.test(leaf.status)
      && !/pending|proposal/iu.test(leaf.status)).length,
    dispositionCounts: Object.fromEntries(Object.entries(dispositions).sort(([left], [right]) => left.localeCompare(right))),
    unresolvedCount: unresolvedLeafIds.length,
    unresolvedLeafIds: unresolvedLeafIds.sort(),
    unresolvedLeaves: unresolvedLeaves.sort((left, right) => left.id.localeCompare(right.id)),
    classifiedLeaves: classifiedLeaves.sort((left, right) => left.id.localeCompare(right.id)),
    sourcePins: validatePins(root, pins, path, diagnostics),
  };
}

function migrationSemanticsReport(root, diagnostics) {
  const path = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
  const source = readText(root, path);
  const counts = topLevelSection(source, "counts");
  const classifications = indentedSection(counts, "uniqueUnitsByClassification", 2);
  const structure = indentedSection(counts, "blockStructureProposalCounts", 2);
  const itemSection = /^items:\s*$/mu.exec(source);
  const items = itemSection ? source.slice(itemSection.index + itemSection[0].length) : "";
  const itemBlocks = items.split(/(?=^- text:)/mu).filter((block) => block.startsWith("- text:"));
  const unresolvedItemIds = [];
  const mixedItemIds = [];
  const unresolvedItems = [];
  const mixedItems = [];
  for (const block of itemBlocks) {
    const id = block.match(/^  itemId: (MPSEM-[0-9]+)[ \t]*$/mu)?.[1];
    const disposition = block.match(/^  classification: ([A-Z_]+)[ \t]*$/mu)?.[1];
    const structuralDisposition = block.match(/^  blockStructureProposal:\n    classification: ([A-Z_]+)[ \t]*$/mu)?.[1];
    if (!id) diagnostics.push(`${path} contains a migration item without an ID`);
    const sourceLocations = [...block.matchAll(/^  - lineStart: (\d+)\n    lineEnd: (\d+)\n    sectionId: ([^\n]*)/gmu)]
      .map((match) => ({ lineStart: Number(match[1]), lineEnd: Number(match[2]), sectionId: ["", "null"].includes(match[3].trim()) ? null : match[3].trim() }));
    const item = {
      id: id ?? null,
      sourceLocations,
      classificationBasis: block.match(/^  classificationBasis: ([^\n]*(?:\n    [^\n]*)*)/mu)?.[1]?.replace(/\n\s+/gu, " ").trim() ?? null,
      decompositionRationale: block.match(/^    rationale: ([^\n]*(?:\n      [^\n]*)*)/mu)?.[1]?.replace(/\n\s+/gu, " ").trim() ?? null,
    };
    if (disposition === "UNRESOLVED" && id) {
      unresolvedItemIds.push(id);
      unresolvedItems.push(item);
    }
    if (structuralDisposition === "MIXED_REQUIRES_DECOMPOSITION" && id) {
      mixedItemIds.push(id);
      mixedItems.push(item);
    }
  }

  const unresolvedCount = numericField(classifications, "UNRESOLVED", 4);
  const mixedCount = numericField(structure, "MIXED_REQUIRES_DECOMPOSITION", 4);
  if (unresolvedItemIds.length !== unresolvedCount) diagnostics.push(`${path} parsed ${unresolvedItemIds.length} unresolved items; declared ${unresolvedCount}`);
  if (mixedItemIds.length !== mixedCount) diagnostics.push(`${path} parsed ${mixedItemIds.length} mixed items; declared ${mixedCount}`);

  const sourcePinBlock = topLevelSection(source, "sourcePin");
  const decisionOverlay = topLevelSection(source, "ownerDecisionOverlay");
  const masterPlanPin = {
    path: sourcePinBlock.match(/^\s{2}path: ([^\n]+)/mu)?.[1]?.trim(),
    sha256: sourcePinBlock.match(/^\s{2}sha256: ([a-f0-9]{64})/mu)?.[1],
  };
  const declaredLineCount = numericField(sourcePinBlock, "lineCount");
  const currentLineCount = readText(root, masterPlanPin.path).split("\n").length - 1;
  const ownerDecisionPin = {
    path: decisionOverlay.match(/^\s{2}path: ([^\n]+)/mu)?.[1]?.trim(),
    sha256: decisionOverlay.match(/^\s{2}sha256: ([a-f0-9]{64})/mu)?.[1],
  };
  const sourceChangeLedger = topLevelSection(source, "sourceChangeLedger");
  const historicalSource = indentedSection(sourceChangeLedger, "historicalSource", 2);
  const observedSource = indentedSection(sourceChangeLedger, "observedCurrentSource", 2);
  const changeClusters = indentedSection(sourceChangeLedger, "clusters", 2)
    .split(/(?=^  - id: MSC-\d+)/mu)
    .filter((block) => /^  - id: MSC-\d+/mu.test(block))
    .map((block) => {
      const stringField = (key) => block.match(new RegExp(`^    ${key}: ([^\\n]*(?:\\n      [^\\n]*)*)`, "mu"))?.[1]
        ?.replace(/\n\s+/gu, " ").replace(/^[|>][-+]?\s*/u, "").trim() ?? null;
      const numericList = (key) => parseInlineArray(block.match(new RegExp(`^    ${key}: \\[([^\\]]*)\\]`, "mu"))?.[1]).map(Number);
      const list = (key) => parseInlineArray(block.match(new RegExp(`^    ${key}: \\[([^\\]]*)\\]`, "mu"))?.[1]);
      return {
        id: block.match(/^  - id: (MSC-\d+)/mu)?.[1] ?? null,
        currentLineSpans: numericList("currentLineSpans"),
        historicalLineSpans: numericList("historicalLineSpans"),
        affectedItemIds: list("affectedItemIds"),
        unmappedStatus: stringField("unmappedStatus"),
        disposition: stringField("disposition"),
        claimDecompositionStatus: stringField("claimDecompositionStatus"),
        decomposedClaimCount: Number(block.match(/^    decomposedClaimCount: (\d+)/mu)?.[1] ?? 0),
        semanticReconciliationStatus: stringField("semanticReconciliationStatus"),
        claimEvidenceRef: stringField("claimEvidenceRef"),
        changedClaims: stringField("changedClaims"),
      };
    });
  const recordedCurrentHash = observedSource.match(/^\s{4}sha256: ([a-f0-9]{64})/mu)?.[1] ?? null;
  const actualCurrentHash = sha256(readText(root, masterPlanPin.path));
  if (recordedCurrentHash !== actualCurrentHash) diagnostics.push(`${path} sourceChangeLedger current master-plan fingerprint is stale`);
  const sourceChangeLedgerSummary = {
    historicalCommit: historicalSource.match(/^\s{4}commit: ([^\n]+)/mu)?.[1]?.trim() ?? null,
    historicalSha256: historicalSource.match(/^\s{4}sha256: ([a-f0-9]{64})/mu)?.[1] ?? null,
    observedCurrentSha256: recordedCurrentHash,
    actualCurrentSha256: actualCurrentHash,
    reconciliationStatus: sourceChangeLedger.match(/^\s{2}reconciliationStatus: ([^\n]+)/mu)?.[1]?.trim() ?? "UNKNOWN",
    pinDisposition: sourceChangeLedger.match(/^\s{2}sourcePinDisposition: ([^\n]+)/mu)?.[1]?.trim() ?? "UNKNOWN",
    diffAgainstHistorical: sourceChangeLedger.match(/^\s{4}diffAgainstHistorical: ([^\n]+)/mu)?.[1]?.trim() ?? null,
    changedClusterCount: changeClusters.length,
    unmappedClusterIds: changeClusters.filter((cluster) => cluster.unmappedStatus).map(({ id }) => id),
    clustersNeedingDecomposition: changeClusters.filter((cluster) => cluster.claimDecompositionStatus !== "exact-claims-recorded" && /needs decomposition/iu.test(cluster.disposition ?? "")).map(({ id }) => id),
    clustersDecomposedSemanticUnresolved: changeClusters.filter((cluster) => cluster.claimDecompositionStatus === "exact-claims-recorded" && cluster.semanticReconciliationStatus === "unresolved").map(({ id }) => id),
    decomposedSourceClaimCount: changeClusters.reduce((total, cluster) => total + cluster.decomposedClaimCount, 0),
    clusters: changeClusters,
    remainingReview: sourceChangeLedger.match(/^\s{2}remainingReview: ([^\n]*(?:\n    [^\n]*)*)/mu)?.[1]?.replace(/\n\s+/gu, " ").trim() ?? null,
  };
  const linkedPins = listPins(topLevelSection(source, "linkedPdpSourcePins"));
  const sourcePins = validatePins(root, [masterPlanPin, ownerDecisionPin, ...linkedPins].filter((pin) => pin.path && pin.sha256), path, diagnostics);
  if (sourcePins.length !== linkedPins.length + 2) diagnostics.push(`${path} is missing a required master-plan or owner-decision source pin`);

  const classificationCounts = Object.fromEntries([...Object.entries({
    UNRESOLVED: numericField(classifications, "UNRESOLVED", 4),
    EVIDENCE_REFERENCE: numericField(classifications, "EVIDENCE_REFERENCE", 4),
    IMPLEMENTATION_GUIDANCE: numericField(classifications, "IMPLEMENTATION_GUIDANCE", 4),
    EXECUTION_ONLY: numericField(classifications, "EXECUTION_ONLY", 4),
    EXTRACTED_TO_PDP: numericField(classifications, "EXTRACTED_TO_PDP", 4),
  })].filter(([, value]) => value !== null));

  return {
    source: path,
    sourceContentBlocks: numericField(counts, "sourceContentBlocks"),
    uniqueContentUnits: numericField(counts, "uniqueContentUnits"),
    unresolvedCount,
    mixedRequiresDecompositionCount: mixedCount,
    partiallyMappedUnresolvedCount: numericField(topLevelSection(source, "ownerDecisionOverlay"), "partiallyMappedUnresolvedBlockCount", 2),
    partialMappingItems: inlineArray(topLevelSection(source, "ownerDecisionOverlay"), "partialMappingItems"),
    sourceChangeLedger: sourceChangeLedgerSummary,
    declaredSourceLineCount: declaredLineCount,
    currentSourceLineCount: currentLineCount,
    sourcePinState: sourcePins.find((pin) => pin.path === masterPlanPin.path)?.state ?? "MISSING",
    staleSourcePinCount: sourcePins.filter((pin) => pin.state !== "CURRENT").length,
    unresolvedItemIds: unresolvedItemIds.sort(),
    mixedItemIds: mixedItemIds.sort(),
    unresolvedItems: unresolvedItems.sort((left, right) => left.id.localeCompare(right.id)),
    mixedItems: mixedItems.sort((left, right) => left.id.localeCompare(right.id)),
    classificationCounts,
    total: numericField(counts, "uniqueContentUnits"),
    applicable: (classificationCounts.EXTRACTED_TO_PDP ?? 0) + unresolvedCount,
    excludedWithRationale: ["EVIDENCE_REFERENCE", "IMPLEMENTATION_GUIDANCE", "EXECUTION_ONLY"].map((classification) => ({
      classification,
      count: numericField(classifications, classification, 4),
      rationaleSource: `${path}#/classificationDefinitions/${classification}`,
      rationale: "Proposal classification only; it does not establish that embedded product claims were independently extracted.",
    })),
    sourcePins,
  };
}

function operationParityReport(root, diagnostics) {
  const path = ".product-experience/interface-parity/operation-parity.yaml";
  const source = readText(root, path);
  const surfacesSection = topLevelSection(source, "surfaces");
  const blocks = surfacesSection.split(/(?=^  - surface: )/mu).filter((block) => /^  - surface: /mu.test(block));
  const surfaces = blocks.map((block) => {
    const name = block.match(/^  - surface: ([^\n]+)/mu)?.[1]?.trim();
    const denominator = block.match(/^    denominator: (\d+)\s*$/mu)?.[1];
    const counts = objectField(block, "operationBindingCounts") ?? objectField(block, "dispositionCounts") ?? {};
    const proposedIdentities = [...new Set([
      ...nestedInlineArrays(block, "explicitlyProposed"),
      ...nestedInlineArrays(block, "proposedSemanticCandidates"),
    ])].sort();
    const unresolvedIdentities = unresolvedValues(block);
    const identities = declaredInlineArray(block, "identities", 4);
    let observedIdentities = identities;
    if (name === "UI action registry") {
      const actionSource = readText(root, ".product-experience/pdp-3-product-experience/action-registry.yaml");
      observedIdentities = [...actionSource.matchAll(/^- id: (media\.action\.[^\n]+)/gmu)].map((match) => match[1].trim()).sort();
      const proposed = new Set(proposedIdentities);
      if (unresolvedIdentities.length === 0) unresolvedIdentities.push(...observedIdentities.filter((identity) => !proposed.has(identity)));
    } else if (name === "HTTP") {
      observedIdentities = identities;
    } else if (name === "gRPC") {
      observedIdentities = [...proposedIdentities, ...unresolvedIdentities].sort();
    } else if (name === "CLI fixture commands") {
      observedIdentities = identities;
    } else if (name === "SDK registry") {
      const nonOperationDispositions = nestedInlineArrays(block, "sourceBackedNonOperationDispositions");
      observedIdentities = [...new Set([...proposedIdentities, ...unresolvedIdentities, ...nonOperationDispositions])].sort();
    } else if (name === "Agent Tool handlers") {
      observedIdentities = identities;
    } else if (name === "lifecycle event names") {
      observedIdentities = [...proposedIdentities, ...unresolvedIdentities].sort();
    } else if (name === "internal runtime events") {
      const explicitEventTypes = declaredInlineArray(block, "explicitEventTypes", 4);
      const dynamicPattern = block.match(/^    dynamicEventPattern: ([^\n]+)/mu)?.[1]?.trim() ?? null;
      const mediaRuntime = readText(root, "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java");
      const terminalMethod = mediaRuntime.match(/private static boolean terminal\(JobStatus status\)\s*\{([^}]*)\}/u)?.[1] ?? "";
      const terminalStatuses = [...terminalMethod.matchAll(/JobStatus\.([A-Z_]+)/gu)].map((match) => match[1]);
      if (dynamicPattern && terminalStatuses.length) {
        const prefix = dynamicPattern.slice(0, dynamicPattern.indexOf("<"));
        observedIdentities = [...new Set([
          ...explicitEventTypes,
          ...terminalStatuses.map((status) => `${prefix}${status.toLowerCase()}`),
        ])].sort();
        unresolvedIdentities.push(...observedIdentities);
      } else {
        observedIdentities = explicitEventTypes.sort();
      }
    }
    if (!name || denominator === undefined) diagnostics.push(`${path} contains an incomplete surface inventory record`);
    if (observedIdentities.length && name !== "internal runtime events" && observedIdentities.length !== Number(denominator ?? 0)) {
      diagnostics.push(`${path} ${name} identity list has ${observedIdentities.length} entries; declared ${denominator}`);
    }
    if (unresolvedIdentities.length && unresolvedIdentities.length !== (counts.unresolved ?? 0)) {
      diagnostics.push(`${path} ${name} unresolved identity list has ${unresolvedIdentities.length} entries; declared ${counts.unresolved ?? 0}`);
    }
    return {
      name,
      denominator: Number(denominator ?? 0),
      counts,
      source: block.match(/^    source: ([^\n]+)/mu)?.[1]?.trim() ?? null,
      observedIdentities: observedIdentities.sort(),
      proposedIdentities,
      unresolvedIdentities: unresolvedIdentities.sort(),
      excludedIdentities: declaredInlineArray(block, "parserArtifactTokensExcludedFromMethodDenominator", 4),
      unresolvedIdentityEvidence: name === "internal runtime events"
        ? { exactIds: observedIdentities, dynamicPattern: block.match(/^    dynamicEventPattern: ([^\n]+)/mu)?.[1]?.trim() ?? null, expandedFrom: "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java#terminal(JobStatus)", exactResidualIdsEnumerated: unresolvedIdentities.length === (counts.unresolved ?? 0) }
        : null,
    };
  });
  const accepted = numericField(topLevelSection(source, "dispositions"), "accepted", 2);
  return {
    source: path,
    status: source.match(/^status: ([^\n]+)/mu)?.[1]?.trim() ?? "UNKNOWN",
    surfaceCount: surfaces.length,
    totalObservedIdentities: surfaces.reduce((sum, surface) => sum + surface.denominator, 0),
    unresolvedIdentityCount: surfaces.reduce((sum, surface) => sum + (surface.counts.unresolved ?? 0), 0),
    acceptedBindingCount: accepted,
    surfaces,
  };
}

function designGateReport(root, diagnostics) {
  const path = ".product-experience/pdp-2-design-interface-system/design-governance.json";
  const record = readJson(root, path);
  const gates = Array.isArray(record.gates) ? record.gates : [];
  if (!Array.isArray(record.gates)) diagnostics.push(`${path} gates must be an array`);
  if (record.gateDenominator !== gates.length) diagnostics.push(`${path} parsed ${gates.length} gates; declared ${record.gateDenominator}`);
  const ids = new Set();
  return gates.map((gate) => {
    if (typeof gate.id !== "string" || !gate.id.trim() || ids.has(gate.id)) {
      diagnostics.push(`${path} contains a missing or duplicate gate ID`);
    } else {
      ids.add(gate.id);
    }
    if (!gate.source || !gate.sourceField || !gate.disposition || !gate.sourceStatus) {
      diagnostics.push(`${path} contains an incomplete gate record: ${gate.id ?? "unknown"}`);
    }
    return {
      id: gate.id ?? "UNKNOWN",
      source: gate.source ?? null,
      sourceField: gate.sourceField ?? null,
      status: gate.disposition ?? "UNKNOWN",
      sourceStatus: gate.sourceStatus ?? "UNKNOWN",
    };
  });
}

function lifecycleReport(root, diagnostics) {
  const obligations = readJson(root, "config/closure/media-product-definition/obligations.json");
  const pending = readJson(root, "config/closure/media-product-definition/pending-decisions.json");
  const consumer = readJson(root, "config/closure/consumer.json");
  if (!Array.isArray(obligations)) diagnostics.push("Lifecycle obligations are not a JSON array");
  const rows = Array.isArray(obligations) ? obligations : [];
  const obligationRecords = rows.map((item) => ({
    id: item.id,
    sourceRef: item.extensions?.["media-source"]?.sourceRef ?? null,
    disposition: item.disposition ?? "UNKNOWN",
    caseIds: item.caseIds ?? [],
    missing: [
      ...(item.caseIds?.length ? [] : ["caseIds"]),
      ...(item.observerIds?.length ? [] : ["observerIds"]),
      ...(item.oracleIds?.length ? [] : ["oracleIds"]),
    ],
  })).sort((left, right) => left.id.localeCompare(right.id));
  return {
    obligationCount: rows.length,
    totalProofRoutes: rows.length,
    proofRouteSource: "config/closure/media-product-definition/obligations.json",
    obligationsWithCaseIds: rows.filter((item) => (item.caseIds ?? []).length > 0).length,
    obligationsWithoutCaseIds: rows.filter((item) => (item.caseIds ?? []).length === 0).length,
    observerAssignments: rows.reduce((sum, item) => sum + (item.observerIds ?? []).length, 0),
    oracleAssignments: rows.reduce((sum, item) => sum + (item.oracleIds ?? []).length, 0),
    providerBindingCount: consumer.providerBindings?.length ?? 0,
    pendingBlockers: (pending.blockers ?? []).map(({ id, status }) => ({ id, status })),
    localReceiptRecordCount: (pending.receipts ?? []).length,
    receiptEvaluation: { status: "NOT_EVALUATED", authoritativeReceiptCount: null },
    currentnessEvaluation: { status: "NOT_EVALUATED", authoritativeCurrentness: null },
    obligationsMissingCaseIds: obligationRecords.filter((item) => item.missing.includes("caseIds")).map(({ id }) => id),
    obligationsMissingObservers: obligationRecords.filter((item) => item.missing.includes("observerIds")).map(({ id }) => id),
    obligationsMissingOracles: obligationRecords.filter((item) => item.missing.includes("oracleIds")).map(({ id }) => id),
    proofRoutes: obligationRecords,
  };
}

function journeyStepReport(root, source, diagnostics) {
  const path = ".product-experience/pdp-3-product-experience/journey-registry.yaml";
  const registry = readText(root, path);
  const journeySection = topLevelSection(registry, "journeys");
  const journeyBlocks = journeySection.split(/(?=^- id: J-\d+)/mu).filter((block) => block.startsWith("- id: J-"));
  const coverageObservation = topLevelSection(registry, "coverageObservation");
  const stepBindings = indentedSection(coverageObservation, "stepBindings", 2);
  const rows = [];
  const journeyRefs = [];
  const seenJourneyIds = new Set();

  for (const journey of journeyBlocks) {
    const id = journey.match(/^- id: (J-\d+)/mu)?.[1];
    const title = journey.match(/^  title: ([^\n]+)/mu)?.[1]?.trim() ?? null;
    const contract = journey.match(/^  contract: ([^\n]+)/mu)?.[1]?.trim();
    if (!id || !contract || seenJourneyIds.has(id)) {
      diagnostics.push(`${path} has a missing, duplicate, or contract-less journey registry record`);
      continue;
    }
    seenJourneyIds.add(id);
    journeyRefs.push({ id, title, sourceRef: `${path}#/journeys/${id}`, contract });
    let content;
    try {
      content = readText(root, `.product-experience/pdp-3-product-experience/${contract}`);
    } catch {
      diagnostics.push(`${path} ${id} contract is missing: ${contract}`);
      continue;
    }
    const stepStarts = [...content.matchAll(/^( {0,2})- (view|stepId):\s*([^\n]+)/gmu)];
    stepStarts.forEach((step, index) => {
      const line = content.slice(0, step.index).split("\n").length;
      const next = stepStarts[index + 1]?.index ?? content.length;
      const block = content.slice(step.index, next);
      const propertyIndent = step[1].length + 2;
      const property = (name) => {
        const expression = new RegExp(`^\\s{${propertyIndent}}${name}:\\s*([^\\n]+)`, "mu");
        const value = block.match(expression)?.[1]?.trim();
        return value?.replace(/^['"]|['"]$/gu, "") ?? null;
      };
      const stepValue = step[3].trim().replace(/^['"]|['"]$/gu, "");
      const stepType = step[2];
      const screenContractRef = property("screenContractRef");
      const actionRef = property("actionRef") ?? property("action");
      const hasScreenContract = Boolean(screenContractRef && screenContractRef !== "null");
      const hasActionBinding = Boolean(actionRef && actionRef !== "null");
      rows.push({
        journeyRef: id,
        ordinal: index + 1,
        stepKey: stepValue,
        stepKeyType: stepType,
        sourceRef: `.product-experience/pdp-3-product-experience/${contract}:${line}`,
        screenContractRef: hasScreenContract ? screenContractRef : null,
        actionRef: hasActionBinding ? actionRef : null,
        screenBindingState: hasScreenContract ? "SOURCE_LINKED" : "UNRESOLVED",
        actionBindingState: hasActionBinding ? "SOURCE_LINKED_PROPOSAL" : "UNRESOLVED",
      });
    });
  }

  const expectedStepCount = numericField(coverageObservation, "orderedStepCount", 2);
  const screenCoverage = indentedSection(stepBindings, "screenContractRef", 4);
  const actionCoverage = indentedSection(stepBindings, "action", 4);
  const declaredScreenLinked = numericField(screenCoverage, "linked", 6);
  const declaredScreenUnresolved = numericField(screenCoverage, "unresolved", 6);
  const declaredActionLinked = numericField(actionCoverage, "linked", 6);
  const declaredActionUnresolved = numericField(actionCoverage, "unresolved", 6);
  const linkedScreenRows = rows.filter((row) => row.screenBindingState === "SOURCE_LINKED");
  const linkedActionRows = rows.filter((row) => row.actionBindingState === "SOURCE_LINKED_PROPOSAL");
  const unresolvedScreenRows = rows.filter((row) => row.screenBindingState === "UNRESOLVED");
  const unresolvedActionRows = rows.filter((row) => row.actionBindingState === "UNRESOLVED");
  if (rows.length !== expectedStepCount) diagnostics.push(`${path} parsed ${rows.length} ordered step records; declared ${expectedStepCount}`);
  if (linkedScreenRows.length !== declaredScreenLinked || unresolvedScreenRows.length !== declaredScreenUnresolved) {
    diagnostics.push(`${path} direct step screen-contract references do not match coverageObservation`);
  }
  if (linkedActionRows.length !== declaredActionLinked || unresolvedActionRows.length !== declaredActionUnresolved) {
    diagnostics.push(`${path} direct step action references do not match coverageObservation`);
  }

  return {
    source: path,
    journeyCount: journeyRefs.length,
    journeyRefs: journeyRefs.sort((left, right) => left.id.localeCompare(right.id)),
    orderedStepCount: rows.length,
    screenContractBindings: {
      linked: linkedScreenRows.length,
      unresolved: unresolvedScreenRows.length,
      blocker: screenCoverage.match(/^\s{6}blocker: ([^\n]+)/mu)?.[1]?.trim() ?? null,
      unresolvedSteps: unresolvedScreenRows,
    },
    actionBindings: {
      linked: linkedActionRows.length,
      unresolved: unresolvedActionRows.length,
      blocker: actionCoverage.match(/^\s{6}blocker: ([^\n]+)/mu)?.[1]?.trim() ?? null,
      linkedSteps: linkedActionRows,
      unresolvedSteps: unresolvedActionRows,
    },
    steps: rows,
  };
}

export function buildMediaProductDefinitionResidualReport(rootPath = resolve(new URL("../..", import.meta.url).pathname)) {
  const root = resolve(rootPath);
  const diagnostics = [];
  const projections = projectionSources.map((source) => projectionReport(root, source, diagnostics));
  const capabilityCoverage = capabilityCoverageReport(root, diagnostics);
  const migrationSemantics = migrationSemanticsReport(root, diagnostics);
  const operationParity = operationParityReport(root, diagnostics);
  const designGates = designGateReport(root, diagnostics);
  const lifecycle = lifecycleReport(root, diagnostics);
  const journeyRegistryPath = ".product-experience/pdp-3-product-experience/journey-registry.yaml";
  const journeyRegistry = readText(root, journeyRegistryPath);
  const journeyTrace = journeyStepReport(root, journeyRegistry, diagnostics);
  const coverageObservation = topLevelSection(journeyRegistry, "coverageObservation");
  const stepBindings = indentedSection(coverageObservation, "stepBindings", 2);
  const screenStepBindings = indentedSection(stepBindings, "screenContractRef", 4);
  const actionStepBindings = indentedSection(stepBindings, "action", 4);
  const experienceSpecification = readJson(root, ".product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json");

  const report = {
    schemaVersion: "media.product-definition-residual-work.v1",
    authority: "diagnostic-only; source mappings, lifecycle evidence, owner acceptance, and phase closure remain separately governed",
    projectionMappingAudit: {
      blockerSource: "generated candidate fieldMappingBlockers",
      completeness: "TOP_LEVEL_SCHEMA_FIELDS_AND_EMPTY_COLLECTION_DECLARATIONS_VALIDATED; NESTED_SEMANTICS_NOT_INFERRED",
      checks: [
        "Current public schema properties are compared with generated candidate keys, field-source mappings, dispositions, and recorded schema-field inventory.",
        "Missing optional fields require an explicit omission disposition; empty candidate collections require a blocker whose status and source match the field disposition and whose reason is nonblank, or an explicit empty-source disposition.",
      ],
      limitation: "These checks detect top-level omissions and unreported empty collections; they do not infer nested record completeness, mapping semantics, owner decisions, or acceptance.",
    },
    projections,
    capabilityCoverage,
    migrationSemantics,
    operationParity,
    designConformance: {
      gateCount: designGates.length,
      resolvedOwnerGateCount: designGates.filter((gate) => gate.status === "RESOLVED_OWNER").length,
      openGateCount: designGates.filter((gate) => gate.status !== "RESOLVED_OWNER").length,
      gates: designGates,
    },
    productExperience: {
      screenViewCount: experienceSpecification.candidateMappingReview?.collectionCounts?.views ?? 0,
      journeyCount: experienceSpecification.candidateMappingReview?.collectionCounts?.registryJourneys ?? 0,
      projectedJourneyCount: experienceSpecification.candidateMappingReview?.collectionCounts?.projectedJourneys ?? 0,
      journeyMappingStatus: experienceSpecification.candidateMappingReview?.fieldDispositions?.journeys?.status ?? "UNKNOWN",
      stepCount: numericField(coverageObservation, "orderedStepCount"),
      stepsWithScreenContracts: journeyTrace.screenContractBindings.linked,
      stepsWithoutScreenContracts: journeyTrace.screenContractBindings.unresolved,
      stepsWithActionBindings: journeyTrace.actionBindings.linked,
      stepsWithoutActionBindings: journeyTrace.actionBindings.unresolved,
      journeyTrace,
    },
    lifecycle,
    diagnostics,
  };
  report.projections.sort((left, right) => left.phase.localeCompare(right.phase));
  report.diagnostics.sort();
  return report;
}

export function renderMediaProductDefinitionResidualMarkdown(report) {
  const lines = [
    "# Media Product Definition residual work",
    "",
    `Authority: ${report.authority}.`,
    `Projection blocker coverage: ${report.projectionMappingAudit.completeness}; source is ${report.projectionMappingAudit.blockerSource}. ${report.projectionMappingAudit.limitation}`,
    "",
    "## Projection mappings",
    "",
    "| Phase | Projection | Mapped fields | Explicit mapping blockers | Owner review pending |",
    "| --- | --- | ---: | ---: | ---: |",
    ...report.projections.map((phase) => `| ${phase.phase} | ${phase.name} | ${phase.mappedFieldCount} | ${phase.unresolvedFieldCount} | ${phase.ownerReviewPendingFieldCount} |`),
    "",
    "## Remaining source work",
    "",
    `- Capability coverage: ${report.capabilityCoverage.leafCount} leaves; ${report.capabilityCoverage.dispositionCounts.JOURNEY_STEP ?? 0} journey steps, ${report.capabilityCoverage.dispositionCounts.MACHINE_OPERATION ?? 0} machine operations, ${report.capabilityCoverage.dispositionCounts.PLATFORM_DEPENDENCY ?? 0} platform dependencies, ${report.capabilityCoverage.unresolvedCount} unresolved.` ,
    `- Migration semantics: ${report.migrationSemantics.uniqueContentUnits} unique content units; ${report.migrationSemantics.unresolvedCount} unresolved and ${report.migrationSemantics.mixedRequiresDecompositionCount} mixed blocks requiring decomposition.` ,
    `  Master-plan pin: ${report.migrationSemantics.sourcePinState}; recorded/current line counts ${report.migrationSemantics.declaredSourceLineCount}/${report.migrationSemantics.currentSourceLineCount}.`,
    `  Master-plan semantic diff: ${report.migrationSemantics.sourceChangeLedger.changedClusterCount} clusters; ${report.migrationSemantics.sourceChangeLedger.unmappedClusterIds.length} lack historical MPSEM IDs; ${report.migrationSemantics.sourceChangeLedger.decomposedSourceClaimCount} exact source claims across ${report.migrationSemantics.sourceChangeLedger.clustersDecomposedSemanticUnresolved.length} clusters are decomposed, with semantic reconciliation unresolved for those clusters. Pin disposition: ${report.migrationSemantics.sourceChangeLedger.pinDisposition}.`,
    `- Interface parity: ${report.operationParity.surfaceCount} surfaces and ${report.operationParity.totalObservedIdentities} observed identities; ${report.operationParity.unresolvedIdentityCount} source identities remain unresolved, with ${report.operationParity.acceptedBindingCount} owner-accepted bindings recorded.` ,
    `- Design conformance: ${report.designConformance.openGateCount}/${report.designConformance.gateCount} recorded authority/review gates remain open.` ,
    `- Product experience: ${report.productExperience.screenViewCount} indexed screen views, ${report.productExperience.journeyCount} journey candidates, ${report.productExperience.stepsWithScreenContracts}/${report.productExperience.stepCount} steps linked to screens, ${report.productExperience.stepsWithActionBindings}/${report.productExperience.stepCount} with action bindings, ${report.productExperience.projectedJourneyCount} projected journeys.` ,
    `- Lifecycle: ${report.lifecycle.obligationCount} obligations; ${report.lifecycle.obligationsWithoutCaseIds} lack case IDs; ${report.lifecycle.observerAssignments} observer and ${report.lifecycle.oracleAssignments} oracle assignments; ${report.lifecycle.providerBindingCount} provider bindings; ${report.lifecycle.localReceiptRecordCount} local receipt records; authoritative receipt/currentness evaluation is NOT_EVALUATED.` ,
    "",
    "Projection blockers:",
    "",
  ];
  const blockers = report.projections.flatMap((phase) => phase.unresolvedFields.map((field) => `- ${field.id}: ${field.status} (${field.reasons.join("; ")})`));
  lines.push(...(blockers.length ? blockers : ["- None."]));
  const stalePins = [...new Map([...report.capabilityCoverage.sourcePins, ...report.migrationSemantics.sourcePins]
    .filter((pin) => pin.state !== "CURRENT")
    .map((pin) => [`${pin.path}:${pin.state}`, pin])).values()];
  if (stalePins.length) {
    lines.push("", "## Stale source review pins", "", ...stalePins.map((pin) => `- ${pin.state}: ${pin.path}`));
  }
  if (report.diagnostics.length) {
    lines.push("", "## Report consistency findings", "", ...report.diagnostics.map((diagnostic) => `- ${diagnostic}`));
  }
  return `${lines.join("\n")}\n`;
}

export function renderMediaProductDefinitionResidualJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
