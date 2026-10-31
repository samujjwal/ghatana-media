import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { INVENTORY_PATH, checkMediaOcrConsumerInventory, scanMediaOcrSignals } from '../scripts/check-media-ocr-consumer-inventory.mjs';

const root = process.cwd();
const inventory = JSON.parse(fs.readFileSync(path.join(root, INVENTORY_PATH), 'utf8'));

test('OCR-C01 inventory accounts for every current Media OCR signal', () => {
  assert.deepEqual(checkMediaOcrConsumerInventory({ root, inventory }), []);
  const migrated = inventory.mediaEntries.filter(entry => entry.disposition === 'DI_MIGRATED');
  assert.deepEqual(migrated.map(entry => entry.id), ['MEDIA-TS-SCENE-TEXT']);
  assert(inventory.mediaEntries.every(entry => entry.disposition !== 'NOT_OCR'), 'Media OCR signals cannot be waved away as NOT_OCR');
});

test('OCR-C01 rejects undeclared call sites, stale paths, false retirement and invalid dispositions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ocr-inventory-'));
  try {
    fs.mkdirSync(path.join(tmp, 'modules/vision/src/main/java'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'modules/vision/src/main/java/Rogue.java'), 'class Rogue { String t(byte[] b) { return engine.extractText(b); } }');
    fs.mkdirSync(path.join(tmp, 'modules/vision/src/test/java'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'modules/vision/src/test/java/RogueTest.java'), 'class RogueTest { void t() { engine.extractText(null); } }');
    fs.mkdirSync(path.join(tmp, 'libs/client/node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'libs/client/node_modules/x/index.js'), 'tesseract.recognize()');
    assert.deepEqual(scanMediaOcrSignals(tmp), ['modules/vision/src/main/java/Rogue.java']);

    const base = { schemaVersion: 'media.ocr-consumer-inventory.v1', externalEntries: [] };
    assert.match(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [] } }).join('\n'), /undeclared Media OCR call site.*Rogue\.java/u);

    const declared = { id: 'ROGUE', paths: ['modules/vision/src/main/java/Rogue.java'], disposition: 'REQUIRES_WORK', remaining: 'migrate' };
    assert.deepEqual(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [declared] } }), []);
    assert.match(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [{ ...declared, disposition: 'RETIRED' }] } }).join('\n'), /RETIRED path .* still exists/u);
    assert.match(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [{ ...declared, disposition: 'DONE' }] } }).join('\n'), /invalid disposition/u);
    assert.match(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [{ ...declared, remaining: undefined }] } }).join('\n'), /lacks remaining work/u);
    assert.match(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [declared, { ...declared, paths: ['gone.java'] }] } }).join('\n'), /duplicate inventory entry IDs|no longer exists/u);

    fs.rmSync(path.join(tmp, 'modules/vision/src/main/java/Rogue.java'));
    assert.match(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [declared] } }).join('\n'), /no longer exists; mark RETIRED/u);
    assert.deepEqual(checkMediaOcrConsumerInventory({ root: tmp, inventory: { ...base, mediaEntries: [{ ...declared, disposition: 'RETIRED' }] } }), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
