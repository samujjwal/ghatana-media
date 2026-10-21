import assert from 'node:assert/strict';
import test from 'node:test';
import {
  p0DirectScripts,
  p1DirectScripts,
  p2DirectScripts,
  p3DirectScripts,
} from '../scripts/report-media-pdp-readiness.mjs';

test('shared readiness reporting code is excluded from all PDP material-source sets', () => {
  const sharedReporter = 'scripts/report-media-pdp-readiness.mjs';
  for (const [phase, scripts] of [
    ['PDP-0', p0DirectScripts],
    ['PDP-1', p1DirectScripts],
    ['PDP-2', p2DirectScripts],
    ['PDP-3', p3DirectScripts],
  ]) {
    assert.equal(scripts.includes(sharedReporter), false,
      `${phase} must not become stale when the shared report runner changes`);
  }
});
