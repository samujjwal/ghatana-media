#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const requireUi=createRequire(new URL('../libs/audio-video-ui/package.json',import.meta.url));
const cssPath=requireUi.resolve('@ghatana/design-system/strict-csp-controls.css');
const css=fs.readFileSync(cssPath,'utf8');
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 await page.setContent(`<style>${css}</style><button class="gh-button">Submit</button><select class="gh-select__control"><option>Test</option></select><textarea class="gh-text-area__input"></textarea><div class="gh-text-field__control"><input></div>`);
 const durations=()=>page.locator('.gh-button,.gh-select__control,.gh-text-area__input,.gh-text-field__control').evaluateAll(els=>els.map(el=>({className:el.className,duration:getComputedStyle(el).transitionDuration})));
 await page.emulateMedia({reducedMotion:'no-preference'});const normal=await durations();
 assert.equal(normal.length,4);assert.ok(normal.every(r=>r.duration.split(',').every(d=>d.trim()==='0.15s')));
 await page.emulateMedia({reducedMotion:'reduce'});const reduced=await durations();
 assert.ok(reduced.every(r=>r.duration==='0s'));
 console.log(JSON.stringify({status:'PASS_DEFINITION_CONTROL_ASSET_BEHAVIOR',command:'node scripts/check-media-shared-control-motion.mjs',browser:browser.version(),publicExport:'@ghatana/design-system/strict-csp-controls.css',cssSha256:crypto.createHash('sha256').update(css).digest('hex'),normal,reduced,independentReview:'NOT_CLAIMED'},null,2));
} finally {await browser.close();}
