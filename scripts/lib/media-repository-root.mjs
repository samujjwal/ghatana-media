import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve a repository root from a module URL without leaving percent-encoded filesystem paths. */
export function repositoryRootForModuleUrl(moduleUrl) {
  return resolve(fileURLToPath(new URL("..", moduleUrl)));
}
