import artifacts from "../specification-artifacts.json";

export type ExperiencePhase = "P0" | "P1" | "P2" | "P3" | "Cross-phase";

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
  P0: "PRODUCT_TRUTH_AUTHORITY",
  P1: "DESIGN_SYSTEM_AUTHORITY",
  P2: "PRODUCT_EXPERIENCE_AUTHORITY",
  P3: "EXPLORER_ADAPTER",
  "Cross-phase": "EVIDENCE_ONLY",
});

function stablePathId(path: string): string {
  return `media.explorer.artifact.${path.replace(/^\.product-experience\//u, "").replace(/[^a-zA-Z0-9]+/gu, ".").replace(/^\.+|\.+$/gu, "").toLocaleLowerCase()}`;
}

function verificationStatusForArtifact(artifact: SpecificationArtifact): string {
  if (artifact.path.endsWith("/PRODUCT-TRUTH.md")) return "BOUNDARY_SLICE_ACCEPTED_FULL_PHASE_PENDING";
  if (artifact.phase === "P0") return "PROPOSAL_P0_010_PENDING";
  if (artifact.phase === "P1") return "PROPOSAL_P1_REVIEW_PENDING";
  if (artifact.phase === "P2") return "PROPOSAL_P2_008_PENDING";
  if (artifact.phase === "P3") return "LOCAL_PROJECTION_TOOLS_BINDING_PENDING";
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
  return {
    stableId: stablePathId(artifact.path),
    canonicalArtifactId: manifestArtifactId(record) || "Not resolved from source manifest",
    authorityClass: authorityClassForPhase[artifact.phase],
    canonicalLocation: artifact.path,
    semanticFingerprint: "PENDING_OWNER_APPROVED_TOOLS_GENERATION",
    currentness: "NOT_GENERATED_CURRENTNESS_YAML_INTENTIONALLY_ABSENT",
    dependencies: record ? manifestRelations(record, "dependencies") : [manifestRef],
    dependents: record ? manifestRelations(record, "dependents") : [manifestRef],
    verificationStatus: verificationStatusForArtifact(artifact),
  };
}
