'use strict';

// Purpose: route Lifecycle temporary Kernel package.yaml projections to the
// Lifecycle-owned pnpm readPackage hook for the Media source-composite lock.
// Consumer: pnpm running from the Media workspace root. This does not own or
// rewrite sibling manifests, and it leaves all non-Lifecycle manifests alone.
// Change policy: add an owner only when that repository is included in this
// workspace and has an owner-maintained readPackage hook; never copy its logic.

const fs = require('node:fs');
const path = require('node:path');

const ownerHooksByRepositoryRef = new Map([
  [
    'ghatana:ghatana-lifecycle',
    path.resolve(__dirname, '../ghatana-lifecycle/.pnpmfile.cjs'),
  ],
]);

function readPackage(pkg, context) {
  if (pkg.kind !== 'package' || pkg.layoutStandard !== 'ghatana.kernel-compat.temp.v1') {
    return pkg;
  }

  const ownerHookPath = ownerHooksByRepositoryRef.get(pkg.repositoryRef);
  if (!ownerHookPath) return pkg;

  if (!fs.existsSync(ownerHookPath)) {
    throw new Error(
      `Temporary package projection ${pkg.name ?? '<unnamed>'} declares ${pkg.repositoryRef}, `
      + `but its owner pnpm hook is missing: ${ownerHookPath}`,
    );
  }

  const ownerHook = require(ownerHookPath);
  if (typeof ownerHook.hooks?.readPackage !== 'function') {
    throw new Error(
      `Temporary package projection ${pkg.name ?? '<unnamed>'} declares ${pkg.repositoryRef}, `
      + `but its owner pnpm hook has no hooks.readPackage function: ${ownerHookPath}`,
    );
  }

  return ownerHook.hooks.readPackage(pkg, context);
}

module.exports = { hooks: { readPackage } };
