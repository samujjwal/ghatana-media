import fs from 'node:fs';
import { validateMediaBuildPlanTaskClosure } from './lib/media-build-plan-task-closure-validation.mjs';

const projectionPath = 'docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json';
const report = validateMediaBuildPlanTaskClosure(JSON.parse(fs.readFileSync(projectionPath, 'utf8')));
console.log(JSON.stringify(report, null, 2));
if (report.structuralStatus !== 'PASS') process.exitCode = 1;
