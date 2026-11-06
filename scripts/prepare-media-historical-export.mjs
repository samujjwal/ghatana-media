#!/usr/bin/env node
/** Prepare a byte-verified working copy of pinned historical Git blobs. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const MANIFEST_NAME = ".media-historical-export-manifest.json";
const DEFAULT_PRESERVATION = "docs/development/historical-content-preservation.json";

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || isAbsolute(value)) throw new Error(`unsafe artifact path: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe artifact path: ${value}`);
  return value;
}

async function ensureContained(root, rel, createParents = false) {
  const target = resolve(root, rel);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`path escapes destination: ${rel}`);
  let cursor = root;
  for (const part of fromRoot.split(sep).slice(0, -1)) {
    cursor = resolve(cursor, part);
    try {
      const st = await lstat(cursor);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe directory component: ${cursor}`);
    } catch (error) {
      if (error.code !== "ENOENT" || !createParents) throw error;
      await mkdir(cursor);
    }
  }
  return target;
}

function gitBlobSha(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

async function streamGitBlob(repo, blob, destination, expectedBytes) {
  const file = await open(destination, "wx");
  const child = spawn("git", ["cat-file", "blob", blob], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  const sha256 = createHash("sha256"), gitSha1 = createHash("sha1");
  let bytes = 0, stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const output = file.createWriteStream();
  gitSha1.update(`blob ${expectedBytes}\0`);
  const done = new Promise((resolvePromise, reject) => {
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`git cat-file failed (${code}): ${stderr}`)));
  });
  const outputDone = finished(output);
  child.stdout.on("data", (chunk) => { bytes += chunk.length; sha256.update(chunk); gitSha1.update(chunk); });
  child.stdout.pipe(output);
  try {
    await Promise.all([done, outputDone]);
    const measured = { bytes, sha256: sha256.digest("hex"), gitSha1: gitSha1.digest("hex") };
    if (measured.bytes !== expectedBytes || measured.gitSha1 !== blob) throw new Error("written blob verification failed");
    return measured;
  } catch (error) {
    child.kill();
    output.destroy();
    await Promise.allSettled([done, outputDone]);
    await unlink(destination).catch((unlinkError) => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
    throw error;
  }
}

async function gitEntry(repo, commit, path) {
  const { stdout } = await new Promise((resolvePromise, reject) => {
    const p = spawn("git", ["ls-tree", "-z", commit, "--", path], { cwd: repo });
    const chunks = []; p.stdout.on("data", (c) => chunks.push(c)); p.on("error", reject); p.on("close", (code) => code === 0 ? resolvePromise({ stdout: Buffer.concat(chunks) }) : reject(new Error("git ls-tree failed")));
  });
  const line = stdout.toString("utf8").replace(/\0$/u, "");
  const match = line.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/u);
  if (!match || match[2] !== path) throw new Error(`pinned regular blob missing: ${path}`);
  return match[1];
}

export async function exportPinned({ repo, destination, preservation }) {
  const pin = JSON.parse(await readFile(preservation, "utf8"));
  if (!/^[a-f0-9]{40}$/u.test(pin.sourceCommit ?? "") || typeof pin.sourceTree !== "string" ||
      !Number.isSafeInteger(pin.total) || pin.total < 0 || !Array.isArray(pin.artifacts) || pin.artifacts.length !== pin.total) {
    throw new Error("preservation document has no complete pinned source inventory");
  }
  const root = resolve(destination); await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const objects = [], paths = new Set();
  for (const item of pin.artifacts) {
    const path = safeRelativePath(item.path);
    if (paths.has(path)) throw new Error(`duplicate pinned path: ${path}`);
    paths.add(path);
    if (!/^[a-f0-9]{40}$/u.test(item.gitBlobSha) || !/^[a-f0-9]{64}$/u.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error(`invalid pinned identity: ${path}`);
    const actualBlob = await gitEntry(repo, pin.sourceCommit, path);
    if (actualBlob !== item.gitBlobSha) throw new Error(`pinned Git blob mismatch: ${path}`);
    const target = await ensureContained(rootReal, path, true);
    const measured = await streamGitBlob(repo, actualBlob, target, item.bytes);
    if (measured.sha256 !== item.sha256) {
      await unlink(target);
      throw new Error(`written blob verification failed: ${path}`);
    }
    objects.push({ path, bytes: measured.bytes, sha256: measured.sha256, gitBlobSha: measured.gitSha1 });
  }
  const manifest = { schemaVersion: "media.historical-export-manifest/v1", sourceCommit: pin.sourceCommit, sourceTree: pin.sourceTree, objects };
  await writeFile(resolve(rootReal, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}

export async function verifyCopy({ destination, manifestPath }) {
  const root = await realpath(destination);
  const manifest = JSON.parse(await readFile(manifestPath ?? resolve(root, MANIFEST_NAME), "utf8"));
  if (manifest.schemaVersion !== "media.historical-export-manifest/v1" || !Array.isArray(manifest.objects)) throw new Error("unsupported export manifest");
  for (const item of manifest.objects) {
    const rel = safeRelativePath(item.path), target = await ensureContained(root, rel);
    const st = await lstat(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`copy is not a regular file: ${rel}`);
    const hash = createHash("sha256"), sha1 = createHash("sha1");
    sha1.update(`blob ${item.bytes}\0`);
    let bytes = 0;
    for await (const chunk of createReadStream(target)) { bytes += chunk.length; hash.update(chunk); sha1.update(chunk); }
    if (bytes !== item.bytes || hash.digest("hex") !== item.sha256 || sha1.digest("hex") !== item.gitBlobSha) throw new Error(`copy verification failed: ${rel}`);
  }
  return { verified: manifest.objects.length, sourceCommit: manifest.sourceCommit };
}

async function main(argv) {
  const mode = argv[0];
  const options = Object.fromEntries(argv.slice(1).reduce((all, arg, i, args) => arg.startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--") ? (all.push([arg.slice(2), args[i + 1]]), all) : all, []));
  const repo = resolve(options.repo ?? ".");
  if (!options.destination) throw new Error("--destination is required");
  if (mode === "export") {
    const result = await exportPinned({ repo, destination: options.destination, preservation: resolve(repo, options.preservation ?? DEFAULT_PRESERVATION) });
    console.log(`Prepared ${result.objects.length} blobs (${result.sourceCommit})`);
  } else if (mode === "verify-copy") {
    const result = await verifyCopy({ destination: options.destination, manifestPath: options.manifest && resolve(options.manifest) });
    console.log(`Verified ${result.verified} copied blobs (${result.sourceCommit})`);
  } else throw new Error("usage: prepare-media-historical-export.mjs export|verify-copy --destination DIR [--repo DIR] [--preservation FILE]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
