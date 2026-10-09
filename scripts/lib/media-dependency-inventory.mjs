import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse: parseYaml } = require("yaml");

const MANIFEST_EXTENSIONS = new Set([".onnx", ".pt", ".pth", ".safetensors", ".gguf", ".ggml", ".tflite", ".pb"]);
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2"]);
const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".wav", ".mp3", ".flac", ".aac", ".ogg", ".avif", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".svg", ".pdf", ".glb", ".gltf", ".usd", ".usdz", ".fbx", ".blend"]);
const NATIVE_EXTENSIONS = new Set([".jar", ".aar", ".so", ".dll", ".dylib", ".wasm"]);
const OTHER_ASSET_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".7z"]);
const GRADLE_CONFIGURATIONS = new Map([
  ["api", "BUILD_RUNTIME"], ["implementation", "BUILD_RUNTIME"], ["runtimeOnly", "BUILD_RUNTIME"],
  ["compileOnly", "BUILD_COMPILE_ONLY"], ["annotationProcessor", "BUILD_COMPILE_ONLY"], ["kapt", "BUILD_COMPILE_ONLY"],
  ["testImplementation", "TEST_ONLY"], ["testRuntimeOnly", "TEST_ONLY"], ["testCompileOnly", "TEST_ONLY"],
]);

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pointerPart(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function lockPackageId(name, version) {
  return `${name}@${version}`;
}

function packageLockKey(id) {
  const peerSuffix = id.indexOf("(");
  return peerSuffix < 0 ? id : id.slice(0, peerSuffix);
}

function sourceRef(path, pointer = undefined) {
  return `${path}${pointer ? `#/${pointer.split("/").map(pointerPart).join("/")}` : ""}`;
}

function manifestProfile(path) {
  if (path.startsWith("archive/")) return "ARCHIVE_NOT_CURRENT_DISTRIBUTION";
  if (path.startsWith("tests/") || /(?:^|\/)test(?:s)?(?:\/|$)/u.test(path)) return "TEST_OR_FIXTURE";
  if (path.startsWith("apps/")) return "APPLICATION_BUILD_PROFILE";
  if (path.startsWith("libs/")) return "LIBRARY_BUILD_PROFILE";
  if (path.startsWith("modules/")) return "SERVICE_BUILD_PROFILE";
  return "REPOSITORY_ROOT_BUILD_PROFILE";
}

function listTrackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean).sort();
}

function parseCargoLock(text, path) {
  const packages = [];
  const blocks = text.split(/^\[\[package\]\]\s*$/mu).slice(1);
  for (const block of blocks) {
    const name = /^name\s*=\s*"([^"]+)"/mu.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/mu.exec(block)?.[1];
    if (!name || !version) continue;
    const source = /^source\s*=\s*"([^"]+)"/mu.exec(block)?.[1] ?? "PATH_OR_WORKSPACE";
    const checksum = /^checksum\s*=\s*"([^"]+)"/mu.exec(block)?.[1] ?? null;
    packages.push({
      ecosystem: "cargo",
      name,
      version,
      source,
      checksum,
      sourceRef: `${path}#[[package]](${name}@${version})`,
      declaredLicense: "NOT_PRESENT_IN_CARGO_LOCK",
      licenseReview: "REVIEW_REQUIRED",
      patentReview: "REVIEW_REQUIRED",
      transitiveLicenseReview: "REVIEW_REQUIRED",
      distributionProfile: "CARGO_LOCKED_PACKAGE; build/runtime profile not derivable from lockfile alone",
    });
  }
  return packages;
}

function gradleCatalog(text) {
  const versions = new Map();
  const libraries = new Map();
  const bundles = new Map();
  let section = "";
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\[([a-z]+)\]$/u.exec(line.trim());
    if (header) { section = header[1]; continue; }
    const entry = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u.exec(line.trim());
    if (!entry) continue;
    const [, key, rawValue] = entry;
    if (section === "versions") {
      const version = /^"([^"]+)"$/u.exec(rawValue)?.[1];
      if (version) versions.set(key, version);
    } else if (section === "libraries") {
      const module = /(?:module\s*=\s*|group\s*=\s*)"([^"]+)"/u.exec(rawValue)?.[1];
      let coordinate = module;
      if (module && !module.includes(":")) {
        const name = /name\s*=\s*"([^"]+)"/u.exec(rawValue)?.[1];
        if (name) coordinate = `${module}:${name}`;
      }
      const fixedVersion = /version\s*=\s*"([^"]+)"/u.exec(rawValue)?.[1];
      const versionRef = /(?:ref\s*=\s*|version\.ref\s*=\s*)"([^"]+)"/u.exec(rawValue)?.[1];
      libraries.set(key, {
        coordinate: coordinate ?? null,
        version: fixedVersion ?? (versionRef ? versions.get(versionRef) ?? `UNRESOLVED_VERSION_REF:${versionRef}` : "UNDECLARED"),
        sourceRef: `gradle/libs.versions.toml#libraries/${key}`,
      });
    } else if (section === "bundles") {
      bundles.set(key, [...rawValue.matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
    }
  }
  return { versions, libraries, bundles };
}

function propertyValues(text) {
  return new Map(text.split(/\r?\n/u).flatMap((line) => {
    const match = /^([^#!\s][^=\s]*)\s*=\s*(.*)$/u.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function gradleDependencies(root, tracked, properties, catalog) {
  const dependencyFiles = tracked.filter((path) => /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/u.test(path));
  const records = [];
  for (const path of dependencyFiles) {
    const text = readFileSync(join(root, path), "utf8");
    const localProperties = new Map(properties);
    for (const match of text.matchAll(/(?:val|var)\s+([A-Za-z0-9_]+)\s*=\s*providers\.gradleProperty\("([^"]+)"\)\.get\(\)/gu)) {
      localProperties.set(match[1], properties.get(match[2]) ?? `UNRESOLVED_GRADLE_PROPERTY:${match[2]}`);
    }
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const match = /^\s*(api|implementation|runtimeOnly|compileOnly|annotationProcessor|testImplementation|testRuntimeOnly|testCompileOnly|kapt)\((.*)\)\s*$/u.exec(line);
      if (!match) continue;
      const [, configuration, argument] = match;
      const profile = GRADLE_CONFIGURATIONS.get(configuration) ?? "UNKNOWN_BUILD_PROFILE";
      const refs = `${path}:${index + 1}`;
      const projectRef = /project\("([^"]+)"\)/u.exec(argument)?.[1];
      if (projectRef) {
        records.push({ ecosystem: "gradle", kind: "local-project", coordinate: projectRef, version: "LOCAL_SOURCE", configuration, distributionProfile: profile, sourceRef: refs, declaredLicense: "NOT_APPLICABLE_TO_LOCAL_PROJECT_REFERENCE", licenseReview: "REVIEW_REQUIRED_AT_ARTIFACT_BOUNDARY", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED_AT_ARTIFACT_BOUNDARY" });
        continue;
      }
      const aliasExpression = /^(?:platform\()?\s*libs\.bundles\.([A-Za-z0-9_.-]+)\s*\)?$/u.exec(argument.trim());
      const dependencyExpression = /^(?:platform\()?\s*libs\.([A-Za-z0-9_.-]+)\s*\)?$/u.exec(argument.trim());
      const alias = aliasExpression?.[1]?.replaceAll(".", "-");
      const singleAlias = dependencyExpression?.[1]?.replaceAll(".", "-");
      const aliases = alias ? catalog.bundles.get(alias) ?? [] : (singleAlias ? [singleAlias] : []);
      if (aliases.length) {
        for (const resolvedAlias of aliases) {
          const item = catalog.libraries.get(resolvedAlias);
          records.push({
            ecosystem: "gradle", kind: "version-catalog-alias", alias: resolvedAlias,
            coordinate: item?.coordinate ?? "UNKNOWN_CATALOG_COORDINATE",
            version: item?.version ?? "UNKNOWN_CATALOG_VERSION",
            configuration, distributionProfile: profile,
            sourceRef: refs, versionSourceRef: item?.sourceRef ?? "gradle/libs.versions.toml#UNRESOLVED_ALIAS",
            declaredLicense: "NOT_PRESENT_IN_VERSION_CATALOG", licenseReview: "REVIEW_REQUIRED",
            patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED_NO_GRADLE_LOCKFILE",
          });
        }
        continue;
      }
      const rawCoordinate = /"([^"]+)"/u.exec(argument)?.[1];
      if (rawCoordinate) {
        const expanded = rawCoordinate.replace(/\$\{providers\.gradleProperty\("([^"]+)"\)\.get\(\)\}/gu, (_whole, key) => localProperties.get(key) ?? `UNRESOLVED_GRADLE_PROPERTY:${key}`)
          .replace(/\$([A-Za-z0-9_]+)/gu, (_whole, key) => localProperties.get(key) ?? `UNRESOLVED_GRADLE_PROPERTY:${key}`);
        const parts = expanded.split(":");
        records.push({ ecosystem: "gradle", kind: "declared-coordinate", coordinate: parts.length >= 2 ? parts.slice(0, 2).join(":") : expanded, version: parts[2] ?? "UNDECLARED", configuration, distributionProfile: profile, sourceRef: refs, declaredLicense: "NOT_PRESENT_IN_GRADLE_DECLARATION", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED_NO_GRADLE_LOCKFILE" });
      } else {
        records.push({ ecosystem: "gradle", kind: "unresolved-declaration", coordinate: argument.trim(), version: "UNRESOLVED", configuration, distributionProfile: profile, sourceRef: refs, declaredLicense: "UNKNOWN", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED_NO_GRADLE_LOCKFILE" });
      }
    }
  }
  return records;
}

function isFixturePath(path) {
  return /(?:^|\/)(?:fixtures?|test-fixtures)(?:\/|\.|$)/iu.test(path)
    || /(?:^|\/)src\/test\/resources\//u.test(path)
    || /(?:^|\/)[^/]*fixtures?[^/]*\.(?:json|ya?ml|csv|txt|xml|bin|wav|png|webp|mp4)$/iu.test(path);
}

function assetKind(path) {
  const ext = extname(path).toLowerCase();
  if (MANIFEST_EXTENSIONS.has(ext)) return "MODEL_OR_WEIGHT_BINARY";
  if (FONT_EXTENSIONS.has(ext)) return "FONT_BINARY";
  if (MEDIA_EXTENSIONS.has(ext)) return "MEDIA_OR_RENDER_ASSET_BINARY";
  if (NATIVE_EXTENSIONS.has(ext)) return "NATIVE_OR_EXECUTABLE_BINARY";
  if (OTHER_ASSET_EXTENSIONS.has(ext)) return "ARCHIVE_BINARY";
  return null;
}

function parseCargoManifest(text, path) {
  const rows = [];
  let section = "";
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const header = /^\[([^\]]+)\]$/u.exec(line.trim());
    if (header) { section = header[1]; continue; }
    if (!["dependencies", "dev-dependencies", "build-dependencies", "workspace.dependencies"].includes(section)
      && !section.endsWith(".dependencies") && !section.endsWith(".dev-dependencies") && !section.endsWith(".build-dependencies")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line.trim());
    if (!match) continue;
    const [, name, raw] = match;
    const version = /^"([^"]+)"$/u.exec(raw)?.[1] ?? /version\s*=\s*"([^"]+)"/u.exec(raw)?.[1] ?? "WORKSPACE_OR_PATH_DEPENDENCY";
    rows.push({ ecosystem: "cargo", kind: "direct-manifest-dependency", name, version, configuration: section, sourceRef: `${path}:${index + 1}`, resolvedLockVersion: "SEE_CARGO_LOCK_PACKAGE_SET", declaredLicense: "NOT_PRESENT_IN_CARGO_MANIFEST_DEPENDENCY_DECLARATION", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED" });
  }
  return rows;
}

export function assertNoDenominatorShrink(report, expected) {
  const actual = report.denominators;
  const failures = [];
  for (const [key, baseline] of Object.entries(expected)) {
    if (typeof baseline !== "number" || typeof actual[key] !== "number") failures.push(`${key}: denominator unavailable`);
    else if (actual[key] < baseline) failures.push(`${key}: shrank from ${baseline} to ${actual[key]}`);
  }
  if (failures.length) throw new Error(`Media dependency inventory denominator regression: ${failures.join("; ")}`);
}

export function buildMediaDependencyInventory(rootPath = process.cwd()) {
  const root = resolve(rootPath);
  const tracked = listTrackedFiles(root);
  const packagePaths = tracked.filter((path) => path.endsWith("package.json") && !path.includes("/node_modules/"));
  const cargoManifestPaths = tracked.filter((path) => path.endsWith("Cargo.toml"));
  const cargoLockPaths = tracked.filter((path) => path.endsWith("Cargo.lock"));
  const pythonManifestPaths = tracked.filter((path) => /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|setup\.py|environment\.ya?ml)$/u.test(path));
  const pnpmLockPath = tracked.includes("pnpm-lock.yaml") ? "pnpm-lock.yaml" : null;
  const pinCandidates = new Set([
    ...packagePaths, ...cargoManifestPaths, ...cargoLockPaths, ...pythonManifestPaths,
    ...tracked.filter((path) => /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|libs\.versions\.toml)$/u.test(path)),
    ...tracked.filter((path) => /(?:^|\/)Dockerfile(?:\.[^/]+)?$/u.test(path)),
    ...tracked.filter((path) => [".product-experience/pdp-0-product-truth/reuse-decisions.yaml", ".product-experience/pdp-0-product-truth/qualification-policy.yaml", "config/provider-manifest.json", "config/route-manifest.json"].includes(path)),
    ...tracked.filter(isFixturePath),
    ...tracked.filter((path) => assetKind(path) !== null),
    "pnpm-lock.yaml",
    "scripts/lib/media-dependency-inventory.mjs",
    "scripts/report-media-dependency-inventory.mjs",
    "tests/media-dependency-inventory.test.mjs",
  ].filter((path) => tracked.includes(path) || path === "scripts/lib/media-dependency-inventory.mjs" || path === "scripts/report-media-dependency-inventory.mjs" || path === "tests/media-dependency-inventory.test.mjs"));
  const sourcePins = [...pinCandidates].sort().map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))), bytes: statSync(join(root, path)).size }));

  const packageManifests = packagePaths.map((path) => {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    const dependencies = [];
    for (const category of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(manifest[category] ?? {})) {
        dependencies.push({ name, declaredVersion: String(version), profile: category, sourceRef: `${path}#/${category}/${pointerPart(name)}`, exactLicense: "UNKNOWN_FROM_DECLARATION", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED" });
      }
    }
    return { path, package: manifest.name ?? null, version: manifest.version ?? null, declaredLicense: manifest.license ?? "NOT_DECLARED", distributionProfile: manifestProfile(path), dependencyCount: dependencies.length, dependencies };
  });

  let pnpmLock = null;
  let directPnpmDependencies = [];
  let lockedNpmPackages = [];
  let pnpmImporterCount = 0;
  if (pnpmLockPath) {
    const lock = parseYaml(readFileSync(join(root, pnpmLockPath), "utf8"));
    const profileByPackage = new Map();
    const traversal = [];
    const importers = lock.importers ?? {};
    pnpmImporterCount = Object.keys(importers).length;
    for (const [importer, record] of Object.entries(importers)) {
      for (const category of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [name, spec] of Object.entries(record[category] ?? {})) {
          const version = spec?.version ?? "UNRESOLVED";
          const id = lockPackageId(name, version);
          directPnpmDependencies.push({ importer, name, requested: spec?.specifier ?? "UNKNOWN", resolved: version, profile: category === "dependencies" ? "RUNTIME" : category === "optionalDependencies" ? "OPTIONAL_RUNTIME" : "DEVELOPMENT_OR_TEST", sourceRef: `${pnpmLockPath}#/importers/${pointerPart(importer)}/${category}/${pointerPart(name)}`, declaredLicense: "NOT_PRESENT_IN_PNPM_LOCKFILE", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED" });
          if (version.startsWith("link:") || version.startsWith("workspace:")) continue;
          const profile = category === "dependencies" ? "RUNTIME" : category === "optionalDependencies" ? "OPTIONAL_RUNTIME" : "DEVELOPMENT_OR_TEST";
          traversal.push({ id, profile, importer });
        }
      }
    }
    const snapshots = lock.snapshots ?? {};
    while (traversal.length) {
      const item = traversal.shift();
      const key = packageLockKey(item.id);
      const profiles = profileByPackage.get(key) ?? new Set();
      const visitKey = `${item.id}\0${item.profile}\0${item.importer}`;
      const seen = profileByPackage.get(`__seen:${visitKey}`);
      if (seen) continue;
      profileByPackage.set(`__seen:${visitKey}`, true);
      profiles.add(`${item.profile}:${item.importer}`);
      profileByPackage.set(key, profiles);
      const snapshot = snapshots[item.id];
      for (const category of ["dependencies", "optionalDependencies"]) {
        for (const [name, spec] of Object.entries(snapshot?.[category] ?? {})) {
          traversal.push({ id: lockPackageId(name, String(spec)), profile: item.profile, importer: item.importer });
        }
      }
    }
    lockedNpmPackages = Object.entries(lock.packages ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, record]) => {
      const split = key.lastIndexOf("@");
      const name = split > 0 ? key.slice(0, split) : key;
      const version = split > 0 ? key.slice(split + 1).split("(")[0] : "UNPARSED";
      const profileRefs = [...(profileByPackage.get(key) ?? [])].filter((value) => typeof value === "string").sort();
      return { name, version, lockKey: key, integrity: record?.resolution?.integrity ?? null, profileRefs, distributionProfile: profileRefs.length ? "REACHABLE_FROM_PNPM_IMPORTER" : "LOCKED_BUT_NO_IMPORTED_PROFILE_RESOLVED", declaredLicense: "NOT_PRESENT_IN_PNPM_LOCKFILE", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED", sourceRef: `${pnpmLockPath}#/packages/${pointerPart(key)}` };
    });
    pnpmLock = { path: pnpmLockPath, lockfileVersion: lock.lockfileVersion ?? "UNKNOWN", importerCount: pnpmImporterCount, lockedPackageCount: lockedNpmPackages.length, packages: lockedNpmPackages, directDependencies: directPnpmDependencies };
  }

  const cargoPackages = cargoLockPaths.flatMap((path) => parseCargoLock(readFileSync(join(root, path), "utf8"), path));
  const cargoDirectDependencies = cargoManifestPaths.flatMap((path) => parseCargoManifest(readFileSync(join(root, path), "utf8"), path));
  const catalogPath = tracked.find((path) => path === "gradle/libs.versions.toml");
  const propertiesPath = tracked.find((path) => path === "gradle.properties");
  const catalog = catalogPath ? gradleCatalog(readFileSync(join(root, catalogPath), "utf8")) : { versions: new Map(), libraries: new Map(), bundles: new Map() };
  const properties = propertiesPath ? propertyValues(readFileSync(join(root, propertiesPath), "utf8")) : new Map();
  const gradle = gradleDependencies(root, tracked, properties, catalog);

  const dockerFiles = tracked.filter((path) => /(?:^|\/)Dockerfile(?:\.[^/]+)?$/u.test(path));
  const unresolvedBuildReferences = [];
  const containerInputs = dockerFiles.flatMap((path) => {
    const lines = readFileSync(join(root, path), "utf8").split(/\r?\n/u);
    const inputs = [];
    let currentStage = "UNNAMED_BUILD_STAGE";
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+([^\s]+))?/iu.exec(line);
      if (from) {
        currentStage = from[2] ?? `stage-${inputs.filter((item) => item.kind === "container-base-image").length + 1}`;
        inputs.push({ kind: "container-base-image", reference: from[1], stage: currentStage, exactDigestPinned: from[1].includes("@sha256:"), distributionProfile: currentStage === "builder" ? "BUILD_ONLY_STAGE_IF_MULTI_STAGE_COPY_CONFIRMED" : "CONTAINER_STAGE_REQUIRES_PROFILE_REVIEW", sourceRef: `${path}:${index + 1}`, declaredLicense: "UNKNOWN_FROM_IMAGE_REFERENCE", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED" });
      }
      const aptStart = /^\s*RUN\s+.*(?:apt-get|apt)\s+install\s+(.+)$/iu.exec(line);
      if (aptStart) {
        const aptLine = index + 1;
        let raw = aptStart[1];
        while (raw.trimEnd().endsWith("\\") && index + 1 < lines.length) raw += ` ${lines[++index]}`;
        const packages = raw.split(/&&|;/u, 1)[0].replaceAll("\\", " ").split(/\s+/u).filter((value) => value && !value.startsWith("-") && !["&&", "||"].includes(value)).map((value) => value.split("=")[0]);
        for (const name of packages) inputs.push({ kind: "container-os-package", reference: name, exactVersionPinned: /=[0-9]/u.test(raw), stage: currentStage, distributionProfile: currentStage === "builder" ? "BUILD_ONLY_STAGE_IF_MULTI_STAGE_COPY_CONFIRMED" : "CONTAINER_STAGE_REQUIRES_PROFILE_REVIEW", sourceRef: `${path}:${aptLine}`, declaredLicense: "UNKNOWN_FROM_DOCKERFILE", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED" });
      }
      const copy = /^\s*(?:COPY|ADD)\s+(?!--from=)([^\s]+)\s+[^\s]+\s*$/u.exec(line);
      if (copy && !copy[1].startsWith("--")) {
        const sourcePath = copy[1].replace(/^\//u, "");
        if (!sourcePath.includes("$") && !existsSync(join(root, sourcePath))) unresolvedBuildReferences.push({ path: sourcePath, sourceRef: `${path}:${index + 1}`, status: "REVIEW_REQUIRED_CONTEXT_OR_SOURCE_MISSING" });
      }
    }
    return inputs;
  });

  const assets = tracked.filter((path) => assetKind(path) || isFixturePath(path)).map((path) => {
    const content = readFileSync(join(root, path));
    const kind = assetKind(path) ?? "SOURCE_FIXTURE_OR_TEST_DATA";
    return { path, kind, bytes: content.length, sha256: sha256(content), distributionProfile: path.startsWith("archive/") ? "ARCHIVE_NOT_CURRENT_DISTRIBUTION" : (kind === "SOURCE_FIXTURE_OR_TEST_DATA" || path.startsWith("docs/implementation/verification/pdp-38/responsive-reference-captures/")) ? "TEST_ONLY_UNLESS_SEPARATELY_PACKAGED" : "REVIEW_DISTRIBUTION_PROFILE", declaredLicense: "UNKNOWN_FROM_FILE_BYTES", licenseReview: "REVIEW_REQUIRED", patentReview: "REVIEW_REQUIRED", transitiveLicenseReview: "REVIEW_REQUIRED_WHERE_DEPENDENT", sourceRef: path };
  });

  const gradleLockfiles = tracked.filter((path) => /(?:^|\/)(?:gradle\.lockfile|verification-metadata\.xml)$/u.test(path));
  const modelAssets = assets.filter((asset) => asset.kind === "MODEL_OR_WEIGHT_BINARY");
  const fontAssets = assets.filter((asset) => asset.kind === "FONT_BINARY");
  const reuseDecisionsPath = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml";
  const qualificationPolicyPath = ".product-experience/pdp-0-product-truth/qualification-policy.yaml";
  const reuseDecisions = parseYaml(readFileSync(join(root, reuseDecisionsPath), "utf8"));
  const qualificationPolicy = parseYaml(readFileSync(join(root, qualificationPolicyPath), "utf8"));
  const selectionRegister = reuseDecisions.selectionRegister ?? {};
  const technologyCandidates = ["ghatanaCandidates", "externalCandidates"].flatMap((candidateKind) => (selectionRegister[candidateKind] ?? []).map((candidate, index) => ({
    id: candidate.id ?? "UNNAMED_CANDIDATE",
    candidateKind,
    decision: candidate.decision ?? "UNKNOWN",
    owner: candidate.owner ?? "UNKNOWN",
    version: candidate.version ?? "NOT_DECLARED",
    versionPinned: typeof candidate.version === "string" && !/not-pinned|not-fully-pinned|not-observed|unknown/iu.test(candidate.version),
    sourceDeclaredLicenseSPDX: candidate.licenseSPDX ?? "NOASSERTION",
    sourceDigest: candidate.sourceDigest ?? "NOT_OBSERVED",
    contract: candidate.publicContract ?? "NOT_DECLARED",
    transitiveLicenseDecision: candidate.transitiveLicenseDecision ?? "NOT_RECORDED",
    securityPosture: candidate.securityPosture ?? "NOT_RECORDED",
    qualificationStatus: candidate.qualificationStatus ?? "NOT_RECORDED",
    licenseAdmission: "NOT_ADMITTED_BY_SELECTION_RECORD",
    patentReview: "REVIEW_REQUIRED",
    distributionProfile: "CANDIDATE_ONLY; actual build or shipped profile not established",
    sourceRef: `${reuseDecisionsPath}#/selectionRegister/${candidateKind}/${index}`,
  })));
  const candidateExceptions = (selectionRegister.ecosystemExceptions ?? []).map((exception, index) => ({
    ...exception,
    licenseAdmission: "OWNER_DISPOSITION_REQUIRED",
    distributionProfile: "TRANSITIVE_EXCEPTION_REPORTED_BY_SELECTION_SOURCE",
    patentReview: "REVIEW_REQUIRED",
    sourceRef: `${reuseDecisionsPath}#/selectionRegister/ecosystemExceptions/${index}`,
  }));
  const denominators = {
    packageManifestCount: packageManifests.length,
    pnpmImporterCount,
    pnpmLockedPackageCount: lockedNpmPackages.length,
    cargoManifestCount: cargoManifestPaths.length,
    cargoLockfileCount: cargoLockPaths.length,
    cargoLockedPackageCount: cargoPackages.length,
    gradleDeclarationCount: gradle.length,
    dockerfileCount: dockerFiles.length,
    pythonDependencyManifestCount: pythonManifestPaths.length,
    trackedAssetOrFixtureCount: assets.length,
    modelOrWeightBinaryCount: modelAssets.length,
    fontBinaryCount: fontAssets.length,
    gradleLockOrVerificationFileCount: gradleLockfiles.length,
    ghatanaCandidateCount: technologyCandidates.filter((candidate) => candidate.candidateKind === "ghatanaCandidates").length,
    externalCandidateCount: technologyCandidates.filter((candidate) => candidate.candidateKind === "externalCandidates").length,
    licenseExceptionCount: candidateExceptions.length,
  };

  return {
    schemaVersion: "media.dependency-inventory.v1",
    authority: "NON_AUTHORITATIVE_SOURCE_INVENTORY_ONLY",
    generatedBy: "scripts/report-media-dependency-inventory.mjs",
    sourceBasis: "tracked source manifests, lockfiles, container files, policy records, and tracked asset/fixture bytes; not an installed SBOM, legal opinion, security assessment, or qualification receipt",
    limitations: [
      "Declared package license fields do not decide permitted use, distribution, patent rights, notices, or compatibility.",
      "Transitive license, patent, security, and native binary closure require owner-approved artifact SBOMs and review.",
      "No model weights, font rights, codec chain, or deployment profile is qualified by this inventory.",
      "Gradle has no checked-in dependency lockfile or verification metadata; resolved transitives and repository artifact identity remain UNKNOWN.",
      "Python source/manifests are separately inventoried; no Python dependency manifest was found in tracked source.",
    ],
    denominators,
    status: {
      licenseAdmission: "UNKNOWN_OR_REVIEW_REQUIRED",
      patentReview: "REVIEW_REQUIRED",
      transitiveDependencyReview: "REVIEW_REQUIRED",
      modelWeightRights: modelAssets.length ? "REVIEW_REQUIRED" : "NO_TRACKED_WEIGHT_BYTES_FOUND; RUNTIME_OR_EXTERNAL_WEIGHTS_REMAIN_UNKNOWN",
      fontRights: fontAssets.length ? "REVIEW_REQUIRED" : "NO_TRACKED_FONT_BYTES_FOUND; EXTERNAL_OR_RUNTIME_FONTS_REMAIN_UNKNOWN",
      codecAndContainerChain: "REVIEW_REQUIRED; source selection does not establish an assembled, licensed, qualified chain",
      ownerDecisions: "REVIEW_REQUIRED_WHERE_EXTERNAL_OWNER_OR_LEGAL_DECISION_IS_NEEDED",
    },
    sourcePins,
    packageManifests,
    pnpmLock,
    cargo: { manifests: cargoManifestPaths, directDependencies: cargoDirectDependencies, locks: cargoLockPaths, lockedPackages: cargoPackages, transitiveLicenseStatus: "UNKNOWN_REQUIRES_SBOM" },
    gradle: { versionCatalog: catalogPath ?? null, declaredDependencies: gradle, lockfiles: gradleLockfiles, transitiveClosureStatus: gradleLockfiles.length ? "LOCKFILE_PRESENT_REVIEW_REQUIRED" : "UNKNOWN_NO_LOCKFILE_OR_VERIFICATION_METADATA" },
    containers: { dockerfiles: dockerFiles, inputs: containerInputs, unresolvedBuildReferences, baseImageDigestAndTransitiveLicenseStatus: "REVIEW_REQUIRED" },
    python: { dependencyManifests: pythonManifestPaths, manifestStatus: pythonManifestPaths.length ? "PRESENT_REVIEW_REQUIRED" : "NONE_FOUND_IN_TRACKED_SOURCE", pythonSourceFiles: tracked.filter((path) => path.endsWith(".py")), dependencyClosureStatus: pythonManifestPaths.length ? "REVIEW_REQUIRED" : "UNKNOWN_NO_DEPENDENCY_MANIFEST" },
    trackedAssets: assets,
    candidatePolicies: {
      reuseDecisionRef: reuseDecisionsPath,
      qualificationPolicyRef: qualificationPolicyPath,
      reuseDecisionStatus: reuseDecisions.status ?? "UNKNOWN",
      externalMechanics: reuseDecisions.externalMechanics ?? null,
      notAdmittedByThisRecord: reuseDecisions.notAdmittedByThisRecord ?? [],
      qualificationPolicyStatus: qualificationPolicy.status ?? "UNKNOWN",
      qualificationPolicyAuthority: qualificationPolicy.authority ?? "UNKNOWN",
      qualificationPolicyDefaultStates: qualificationPolicy.capabilityCoverage ? {
        implementation: qualificationPolicy.capabilityCoverage.defaultImplementationState,
        licenseAdmission: qualificationPolicy.capabilityCoverage.defaultLicenseAdmissionState,
        qualification: qualificationPolicy.capabilityCoverage.defaultQualificationState,
        runtimeAvailability: qualificationPolicy.capabilityCoverage.defaultRuntimeAvailability,
      } : null,
      technologyCandidates,
      exceptions: candidateExceptions,
      statement: "Candidates and architecture selections remain unadmitted until exact distribution profile, artifact/model/asset digests, owner permission, full dependency closure, license/patent, security, and qualification evidence are reviewed.",
    },
  };
}

export function renderDependencyInventoryMarkdown(report) {
  const rows = Object.entries(report.denominators).map(([name, count]) => `| ${name} | ${count} |`).join("\n");
  const packageRows = report.packageManifests.map((item) => `| ${item.path} | ${item.package ?? "(unnamed)"} | ${item.version ?? "UNDECLARED"} | ${item.declaredLicense} | ${item.distributionProfile} | ${item.dependencyCount} |`).join("\n");
  const assetRows = report.trackedAssets.length ? report.trackedAssets.map((item) => `| ${item.path} | ${item.kind} | ${item.bytes} | ${item.declaredLicense} | ${item.distributionProfile} |`).join("\n") : "| (none found) | — | — | — | — |";
  const candidateRows = report.candidatePolicies.technologyCandidates.map((item) => `| ${item.id} | ${item.decision} | ${item.version} | ${item.sourceDeclaredLicenseSPDX} | ${item.transitiveLicenseDecision} | ${item.qualificationStatus} |`).join("\n");
  return [
    "# Media source dependency inventory",
    "",
    `Schema: \`${report.schemaVersion}\`  `,
    `Authority: \`${report.authority}\`  `,
    "This source inventory is not an SBOM, legal opinion, security assessment, or qualification receipt.",
    "",
    "## Denominators",
    "",
    "| Source population | Count |",
    "|---|---:|",
    rows,
    "",
    "## Package manifests",
    "",
    "| Source | Package | Version | Declared license | Profile | Direct declarations |",
    "|---|---|---|---|---|---:|",
    packageRows,
    "",
    "## Tracked binaries and fixture data",
    "",
    "| Source | Kind | Bytes | Declared license | Profile |",
    "|---|---|---:|---|---|",
    assetRows,
    "",
    "## Architecture selections (not admissions)",
    "",
    "| Candidate | Decision | Version | Source-declared SPDX | Transitive license state | Qualification state |",
    "|---|---|---|---|---|---|",
    candidateRows,
    "",
    "## Review states",
    "",
    ...Object.entries(report.status).map(([name, value]) => `- **${name}:** ${value}`),
    "",
    "## Limits",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
    "Exact dependency rows, lock references, asset digests, and source SHA-256 pins are in the adjacent JSON report.",
    "",
  ].join("\n");
}
