import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateMediaBuildPlanTaskClosure } from './lib/media-build-plan-task-closure-validation.mjs';
import { inspectMaterialSourceReceipt } from './lib/media-build-f00-t01-observation.mjs';
import { projectMediaBuildScopedTaskPlanning } from './lib/media-build-scoped-task-planning.mjs';
import { pdp0PhaseScopedSourcePins } from './report-media-pdp-readiness.mjs';

const paths = {
  queue: 'docs/implementation/MEDIA-GTOOL-EXECUTION-QUEUE.v2.json',
  workPackages: 'docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json'
};
const read = path => fs.readFileSync(path, 'utf8');
const queue = JSON.parse(read(paths.queue));
const workPackages = JSON.parse(read(paths.workPackages));
const structuralValidation = validateMediaBuildPlanTaskClosure(workPackages);
const phaseSourceRecords = [0, 1, 2, 3].map(index => ({
  phase: `PDP-${index}`,
  ...JSON.parse(read(`docs/implementation/pdp-${index}-phase-dev-status.json`))
}));
const surfaceMatrices = [0, 1, 2, 3].map(index => ({
  phase: `PDP-${index}`,
  ...JSON.parse(read(`docs/implementation/verification/pdp-38/pdp${index}-surface-phase-status-matrix.json`))
}));
const report = projectMediaBuildScopedTaskPlanning({ queue, workPackages, structuralValidation, phaseSourceRecords, phaseProjectionPins: pdp0PhaseScopedSourcePins(), surfaceMatrices });
report.materialSourceReceiptDiagnostic = inspectMaterialSourceReceipt({
  root: process.cwd(),
  phaseStatuses: phaseSourceRecords,
  receipt: workPackages.materialSourceReceipt,
  pdp0ProjectionPins: pdp0PhaseScopedSourcePins()
});
report.sourceBaseline = {
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourcePins: Object.entries(workPackages.sourcePins ?? {}).map(([relativePath, expectedSha256]) => {
    const absolutePath = path.resolve(relativePath);
    const exists = fs.existsSync(absolutePath);
    const currentSha256 = exists ? crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex') : null;
    return {
      path: relativePath,
      expectedSha256,
      currentSha256,
      status: exists && currentSha256 === expectedSha256 ? 'CURRENT' : exists ? 'STALE' : 'MISSING'
    };
  })
};
report.inputSources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, {
  path,
  sha256: `sha256:${crypto.createHash('sha256').update(read(path)).digest('hex')}`
}]));
report.currentWorkingTree = {
  note: 'Source pin evaluation is against current working-tree bytes; dirty files are not treated as current by commit identity.'
};
console.log(JSON.stringify(report, null, 2));
