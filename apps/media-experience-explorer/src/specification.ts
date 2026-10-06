import artifacts from "../specification-artifacts.json";

export type ExperiencePhase = "PDP-0" | "PDP-1" | "PDP-2" | "PDP-3" | "EXPLORER" | "CROSS_PHASE" | "IMPLEMENTATION" | "EVIDENCE" | "REFERENCE" | "OBSOLETE";

export interface SpecificationArtifact {
  readonly phase: ExperiencePhase;
  readonly path: string;
  readonly title: string;
}

export interface ArtifactTraceMetadata {
  readonly stableId: string;
  readonly canonicalArtifactId: string;
  readonly authorityClass: string;
  readonly canonicalLocation: string;
  readonly semanticFingerprint: string;
  readonly currentness: string;
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly verificationStatus: string;
}

export const specificationArtifacts: readonly SpecificationArtifact[] = Object.freeze(artifacts as SpecificationArtifact[]);

const authorityClassForPhase: Readonly<Record<ExperiencePhase, string>> = Object.freeze({
  "PDP-0": "PRODUCT_TRUTH_AUTHORITY",
  "PDP-1": "DOMAIN_DATA_AUTHORITY",
  "PDP-2": "DESIGN_INTERFACE_AUTHORITY",
  "PDP-3": "PRODUCT_EXPERIENCE_AUTHORITY",
  EXPLORER: "EXPLORER_PROJECTION",
  CROSS_PHASE: "CROSS_PHASE_GOVERNANCE",
  IMPLEMENTATION: "IMPLEMENTATION_PROJECTION",
  EVIDENCE: "EVIDENCE_PROJECTION",
  REFERENCE: "REFERENCE_ONLY",
  OBSOLETE: "OBSOLETE_REFERENCE",
});

function verificationStatusForArtifact(artifact: SpecificationArtifact): string {
  if (artifact.path.endsWith("/PRODUCT-TRUTH.md")) return "BOUNDARY_SLICE_ACCEPTED_FULL_PHASE_PENDING";
  if (artifact.phase === "PDP-0") return "PROPOSAL_PDP0_INDEPENDENT_REVIEW_PENDING";
  if (artifact.phase === "PDP-1") return "PROPOSAL_PDP1_SEMANTIC_REVIEW_PENDING";
  if (artifact.phase === "PDP-2") return "PROPOSAL_PDP2_DESIGN_REVIEW_PENDING";
  if (artifact.phase === "PDP-3") return "PROPOSAL_PDP3_EXPERIENCE_REVIEW_PENDING";
  if (artifact.phase === "EXPLORER") return "LOCAL_PROJECTION_TOOLS_BINDING_PENDING";
  return "GOVERNANCE_RECORD_OWNER_REVIEW_PENDING";
}

function manifestRecordForArtifact(source: string, path: string): string {
  const pathIndex = source.search(new RegExp(`^    path: ${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  if (pathIndex < 0) return "";
  const recordStart = source.lastIndexOf("\n  - artifactId:", pathIndex);
  const nextRecord = source.indexOf("\n  - artifactId:", pathIndex + 1);
  return source.slice(recordStart < 0 ? 0 : recordStart, nextRecord < 0 ? source.length : nextRecord);
}

function manifestScalar(record: string, key: string): string {
  return record.match(new RegExp(`^    ${key}:\\s*(.+)$`, "mu"))?.[1]?.trim() ?? "";
}

function manifestArtifactId(record: string): string {
  return record.match(/^  - artifactId:\s*(.+)$/mu)?.[1]?.trim() ?? "";
}

function manifestRelations(record: string, section: "dependencies" | "dependents"): readonly string[] {
  const sectionMatch = record.match(new RegExp(`^    ${section}:\\s*$`, "mu"));
  if (!sectionMatch || sectionMatch.index === undefined) return ["Not recorded in source manifest"];
  const lines = record.slice(sectionMatch.index + sectionMatch[0].length).split(/\r?\n/u);
  const values: string[] = [];
  let activeKey = "";
  for (const line of lines) {
    if (/^    [A-Za-z][\w-]*:/u.test(line)) break;
    const field = line.match(/^      ([A-Za-z][\w-]*):\s*(.*)$/u);
    if (field) {
      activeKey = field[1]!;
      if (field[2]) values.push(`${activeKey}: ${field[2]}`);
      continue;
    }
    const listItem = line.match(/^      -\s+(.+)$/u);
    if (listItem && activeKey) values.push(`${activeKey}: ${listItem[1]}`);
  }
  return values.length ? values : ["No declared relations"];
}

/**
 * Return trace metadata without inventing semantic authority. Tools-owned
 * semantic fingerprints and generated currentness are deliberately reported
 * as pending until the published validator/generator binding is available.
 */
export function traceMetadataForArtifact(artifact: SpecificationArtifact, sourceManifest = ""): ArtifactTraceMetadata {
  const manifestRef = ".product-experience/source-manifest.yaml";
  const record = manifestRecordForArtifact(sourceManifest, artifact.path);
  const canonicalArtifactId = manifestArtifactId(record);
  return {
    stableId: canonicalArtifactId || "media.explorer.artifact.unresolved",
    canonicalArtifactId: canonicalArtifactId || "Not resolved from source manifest",
    authorityClass: authorityClassForPhase[artifact.phase],
    canonicalLocation: artifact.path,
    semanticFingerprint: "PENDING_OWNER_APPROVED_TOOLS_GENERATION",
    currentness: "NOT_GENERATED_CURRENTNESS_YAML_INTENTIONALLY_ABSENT",
    dependencies: record ? manifestRelations(record, "dependencies") : [manifestRef],
    dependents: record ? manifestRelations(record, "dependents") : [manifestRef],
    verificationStatus: verificationStatusForArtifact(artifact),
  };
}
