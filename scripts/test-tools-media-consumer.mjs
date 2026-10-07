import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsRoot = path.resolve(mediaRoot, "../ghatana-tools");
const toolsPackageRoots = [
  path.join(toolsRoot, "libs/product-development"),
  path.join(toolsRoot, "tools/product-development/explorer"),
];
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ghatana-tools-media-consumer-"));
const createdToolLinks = [];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed with exit ${result.status}`);
}

async function readPackage(packageDir) {
  return JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
}

try {
  const packageDirs = new Map();
  for (const root of toolsPackageRoots) {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = [root, ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))];
    for (const packageDir of candidates) {
      try {
        const manifest = await readPackage(packageDir);
        if (manifest.name?.startsWith("@ghatana/")) packageDirs.set(manifest.name, packageDir);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  const packageOrder = [];
  const visited = new Set();
  const visiting = new Set();
  async function visit(name) {
    if (visited.has(name)) return;
    assert.ok(
      packageDirs.has(name),
      `Tools source package ${name} is missing; this check requires the sibling ghatana-tools checkout at ${toolsRoot}`,
    );
    assert.ok(!visiting.has(name), `Tools package dependency cycle includes ${name}`);
    visiting.add(name);
    const manifest = await readPackage(packageDirs.get(name));
    for (const dependencyName of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (dependencyName.startsWith("@ghatana/")) await visit(dependencyName);
    }
    visiting.delete(name);
    visited.add(name);
    packageOrder.push(name);
  }

  for (const packageName of [
    "@ghatana/product-dev-explorer",
    "@ghatana/experience-explorer-contracts",
    "@ghatana/experience-package",
    "@ghatana/development-traceability",
  ]) {
    await visit(packageName);
  }

  const artifactDir = path.join(tempRoot, "artifacts");
  const extractedDir = path.join(tempRoot, "packages");
  const nodeModulesDir = path.join(tempRoot, "node_modules/@ghatana");
  await Promise.all([mkdir(artifactDir, { recursive: true }), mkdir(extractedDir, { recursive: true }), mkdir(nodeModulesDir, { recursive: true })]);

  // Recreate the workspace dependency links needed for package builds when the
  // sibling checkout has not had a workspace install. These ignored node_modules
  // links are removed in finally and never participate in the consumer import.
  for (const packageName of packageOrder) {
    const packageDir = packageDirs.get(packageName);
    const manifest = await readPackage(packageDir);
    for (const dependencyName of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (!dependencyName.startsWith("@ghatana/") || !packageDirs.has(dependencyName)) continue;
      const dependencyLink = path.join(packageDir, "node_modules", "@ghatana", dependencyName.split("/")[1]);
      try {
        await readFile(path.join(dependencyLink, "package.json"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await mkdir(path.dirname(dependencyLink), { recursive: true });
        await symlink(packageDirs.get(dependencyName), dependencyLink, "dir");
        createdToolLinks.push(dependencyLink);
      }
    }
  }

  for (const packageName of packageOrder) {
    const packageDir = packageDirs.get(packageName);
    const manifest = await readPackage(packageDir);
    run("pnpm", ["run", "build"], packageDir);
    run("pnpm", ["pack", "--pack-destination", artifactDir], packageDir);

    const tarball = path.join(artifactDir, `ghatana-${manifest.name.split("/")[1]}-${manifest.version}.tgz`);
    const packageExtractDir = path.join(extractedDir, `${manifest.name.split("/")[1]}-${manifest.version}`);
    await mkdir(packageExtractDir, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", packageExtractDir]);
    const extractedPackage = path.join(packageExtractDir, "package");
    if (manifest.exports?.["./schema"]) {
      const schemaTarget = path.join(extractedPackage, manifest.exports["./schema"]);
      assert.ok((await readFile(schemaTarget)).length > 0, `${packageName} public schema export must be included in its tarball`);
    }
    await symlink(extractedPackage, path.join(nodeModulesDir, manifest.name.split("/")[1]), "dir");
  }

  const fixtureMediaDir = path.join(tempRoot, "libs/media-experience-simulation");
  const fixtureExplorerDir = path.join(tempRoot, "apps/media-experience-explorer/src");
  const fixtureTestsDir = path.join(tempRoot, "tests");
  await Promise.all([
    mkdir(fixtureMediaDir, { recursive: true }),
    mkdir(fixtureExplorerDir, { recursive: true }),
    mkdir(fixtureTestsDir, { recursive: true }),
  ]);
  await Promise.all([
    cp(path.join(mediaRoot, "libs/media-experience-simulation/src"), path.join(fixtureMediaDir, "src"), { recursive: true }),
    cp(path.join(mediaRoot, "libs/media-experience-simulation/package.json"), path.join(fixtureMediaDir, "package.json")),
    cp(path.join(mediaRoot, "libs/media-experience-simulation/tsconfig.json"), path.join(fixtureMediaDir, "tsconfig.json")),
    cp(path.join(mediaRoot, "apps/media-experience-explorer/src/tools-consumer.ts"), path.join(fixtureExplorerDir, "tools-consumer.ts")),
    cp(path.join(mediaRoot, "tests/tools-media-consumer.test.mjs"), path.join(fixtureTestsDir, "tools-media-consumer.test.mjs")),
  ]);
  await symlink(fixtureMediaDir, path.join(nodeModulesDir, "media-experience-simulation"), "dir");

  run(
    path.join(mediaRoot, "libs/media-experience-simulation/node_modules/.bin/tsc"),
    ["-p", path.join(fixtureMediaDir, "tsconfig.json")],
    mediaRoot,
  );
  run(process.execPath, ["--experimental-strip-types", "--test", path.join(fixtureTestsDir, "tools-media-consumer.test.mjs")], tempRoot);
} finally {
  for (const link of createdToolLinks.reverse()) await rm(link, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}
