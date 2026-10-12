const PACK_VERSION = "ghatana.surface-experience-pack.v1";
const SHOW_VERSION = "gtool.experience-show.v1";
const SOURCE_CANDIDATE = "LIFECYCLE_GTOOL_SOURCE_CANDIDATE";
const CHANNELS = new Set(["HEADLESS", "GUI", "CLI", "API", "SDK", "EVENT"]);

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value) => typeof value === "string";
const nullableString = (value) => value === null || string(value);
const exactKeys = (value, required, optional = []) => object(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

function page(value) {
  return exactKeys(value, ["items", "total", "offset", "limit", "nextOffset"])
    && Array.isArray(value.items)
    && Number.isInteger(value.total) && value.total >= 0
    && Number.isInteger(value.offset) && value.offset >= 0
    && Number.isInteger(value.limit) && value.limit >= 1
    && (value.nextOffset === null || (Number.isInteger(value.nextOffset) && value.nextOffset >= 0));
}

function lazySource(value) {
  return value === null || (exactKeys(value, ["path", "status"], ["digest", "bytes", "selector"])
    && string(value.path)
    && ["PRESENT", "MISSING"].includes(value.status)
    && (!Object.hasOwn(value, "digest") || string(value.digest))
    && (!Object.hasOwn(value, "bytes") || (Number.isInteger(value.bytes) && value.bytes >= 0))
    && (!Object.hasOwn(value, "selector") || nullableString(value.selector))
    && (value.status !== "PRESENT" || (string(value.digest) && Number.isInteger(value.bytes))));
}

function phase(value) {
  if (!exactKeys(value, ["id", "applicability"], ["pdpPhase", "title", "rationale", "declaredStatus", "unitIdentity", "definition"])) return false;
  if (!string(value.id) || !string(value.applicability)) return false;
  for (const key of ["pdpPhase", "title", "rationale", "declaredStatus", "unitIdentity"]) {
    if (Object.hasOwn(value, key) && !nullableString(value[key])) return false;
  }
  if (Object.hasOwn(value, "definition") && value.definition !== null) {
    const definition = value.definition;
    if (!exactKeys(definition, ["source", "selector", "digest", "selectorDigest", "selectorStatus"])
      || !string(definition.source) || !string(definition.selector)
      || !nullableString(definition.digest) || !nullableString(definition.selectorDigest)
      || !["SELECTOR_RESOLVED", "SELECTOR_NOT_FOUND", "SELECTOR_AMBIGUOUS", "SOURCE_MISSING"].includes(definition.selectorStatus)) return false;
  }
  return true;
}

function packMatchesSchema(pack) {
  if (!exactKeys(pack, ["schemaVersion", "surface", "program", "hierarchy", "phases", "journeys", "channels", "sources", "provenance"], ["selectedPhase", "experience"])) return false;
  if (pack.schemaVersion !== PACK_VERSION) return false;
  const surface = pack.surface;
  if (!exactKeys(surface, ["id", "kind", "admissionStatus", "programId", "boundPrograms"], ["title", "acceptanceDecision", "unitIdentityPrefix"])
    || !string(surface.id) || !["PHYSICAL", "LOGICAL", "COMPOSITION", "REPOSITORY"].includes(surface.kind)
    || !string(surface.admissionStatus) || !string(surface.programId)
    || !Array.isArray(surface.boundPrograms) || !surface.boundPrograms.every(string)
    || (Object.hasOwn(surface, "title") && !nullableString(surface.title))
    || (Object.hasOwn(surface, "acceptanceDecision") && !nullableString(surface.acceptanceDecision))
    || (Object.hasOwn(surface, "unitIdentityPrefix") && !nullableString(surface.unitIdentityPrefix))) return false;

  const program = pack.program;
  if (!exactKeys(program, ["programId", "phases"], ["title"]) || !string(program.programId)
    || (Object.hasOwn(program, "title") && !nullableString(program.title))
    || !Array.isArray(program.phases)
    || !program.phases.every((item) => exactKeys(item, ["id"], ["title", "pdpPhase"]) && string(item.id)
      && (!Object.hasOwn(item, "title") || nullableString(item.title))
      && (!Object.hasOwn(item, "pdpPhase") || nullableString(item.pdpPhase)))) return false;

  const hierarchy = pack.hierarchy;
  if (!exactKeys(hierarchy, ["parents", "breadcrumbs", "multiParent", "children", "watchedChildren"], ["rootId"])
    || !Array.isArray(hierarchy.parents) || !hierarchy.parents.every(string)
    || !Array.isArray(hierarchy.breadcrumbs)
    || !hierarchy.breadcrumbs.every((item) => exactKeys(item, ["path"]) && Array.isArray(item.path) && item.path.every(string))
    || typeof hierarchy.multiParent !== "boolean" || !page(hierarchy.children) || !page(hierarchy.watchedChildren)
    || (Object.hasOwn(hierarchy, "rootId") && !nullableString(hierarchy.rootId))) return false;

  if (!Array.isArray(pack.phases) || !pack.phases.every(phase)
    || (Object.hasOwn(pack, "selectedPhase") && !(pack.selectedPhase === null || phase(pack.selectedPhase)))
    || !page(pack.journeys) || !Array.isArray(pack.channels) || !pack.channels.every((item) => CHANNELS.has(item))) return false;
  if (Object.hasOwn(pack, "experience") && !(pack.experience === null || object(pack.experience))) return false;

  const sources = pack.sources;
  if (!exactKeys(sources, ["requirements", "descriptor", "experience", "phaseBinding"])
    || !lazySource(sources.requirements) || !lazySource(sources.descriptor) || !lazySource(sources.experience)
    || !(sources.phaseBinding === null || (exactKeys(sources.phaseBinding, [], ["bindingId"])
      && (!Object.hasOwn(sources.phaseBinding, "bindingId") || nullableString(sources.phaseBinding.bindingId))))) return false;
  const provenance = pack.provenance;
  if (!exactKeys(provenance, ["sourceDigests", "lazy"]) || !object(provenance.sourceDigests)
    || !Object.values(provenance.sourceDigests).every(string) || provenance.lazy !== true) return false;
  return true;
}

/**
 * Negotiate the pinned Lifecycle source-candidate protocol and validate its
 * read-only gtool envelope and pack. This adapter does no network or file IO.
 */
export function consumeLifecyclePackCandidate({ source, payload, selector, supportedVersions = [PACK_VERSION] } = {}) {
  if (source !== SOURCE_CANDIDATE) return { ok: false, reason: "UNSUPPORTED_SOURCE" };
  if (!object(payload) || payload.schemaVersion !== SHOW_VERSION) return { ok: false, reason: "UNSUPPORTED_ENVELOPE_VERSION" };
  if (payload.mode !== "OBSERVATION" || payload.readOnly !== true || !object(payload.pack)) return { ok: false, reason: "READ_ONLY_OBSERVATION_REQUIRED" };
  const version = payload.pack.schemaVersion;
  if (!Array.isArray(supportedVersions) || !supportedVersions.includes(version)) return { ok: false, reason: "UNSUPPORTED_PACK_VERSION", version };
  if (!packMatchesSchema(payload.pack)) return { ok: false, reason: "PACK_SCHEMA_INVALID", version };
  if (!object(selector) || !string(selector.surfaceId) || !string(selector.programId)) return { ok: false, reason: "SELECTOR_REQUIRED" };
  if (payload.pack.surface.id !== selector.surfaceId || payload.pack.program.programId !== selector.programId
    || payload.pack.surface.programId !== selector.programId) return { ok: false, reason: "SELECTOR_MISMATCH", version };
  if (payload.pack.surface.admissionStatus !== "PROPOSED_OWNER_ADMISSION" || payload.pack.surface.unitIdentityPrefix !== null) {
    return { ok: false, reason: "SOURCE_CANDIDATE_REQUIRED", version };
  }
  return { ok: true, mode: "TEST_ONLY", version, nativeLifecycleStatus: "NOT_ADMITTED", pack: payload.pack };
}

export const lifecyclePackCandidateProtocol = Object.freeze({ source: SOURCE_CANDIDATE, packVersion: PACK_VERSION, envelopeVersion: SHOW_VERSION });
