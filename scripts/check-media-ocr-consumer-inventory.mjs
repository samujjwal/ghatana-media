import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INVENTORY_PATH = 'docs/migration/ocr-consumer-inventory.v1.json';
const SOURCE_ROOTS = ['adapters', 'apps', 'config', 'launcher', 'libs', 'modules', 'providers', 'runtime-contracts'];
const SOURCE_EXTENSIONS = new Set(['.java', '.kt', '.kts', '.ts', '.tsx', '.mts', '.js', '.mjs', '.rs', '.py', '.proto', '.json', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'target', '.gradle', 'coverage', '.turbo']);
const OCR_SIGNAL = /\bOcrService\b|\bKernelOcrProviderAdapter\b|\bOcrProvider\b|\bextractText\s*\(|\bVisionCapability\.OCR\b|\bpaddleocr\b|\bPaddleOCR\b|\btesseract\b|\bTesseract\b|\bDocumentIntelligenceSceneTextAdapter\b|\bDocumentIntelligenceV1\b|"media\.ocr"/u;
const TEST_PATH = /(^|\/)(src\/test|__tests__|test|tests)\/|\.(test|spec)\.[cm]?[jt]sx?$/u;
const VOCABULARY = new Set(['DI_MIGRATED', 'RETIRED', 'REQUIRES_WORK', 'NOT_OCR']);

function walk(root, relative, out) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return out;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, child, out);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(child);
  }
  return out;
}

/** Return non-test Media source files that carry an OCR signal. */
export function scanMediaOcrSignals(root) {
  return SOURCE_ROOTS.flatMap(dir => walk(root, dir, []))
    .filter(file => !TEST_PATH.test(file))
    .filter(file => OCR_SIGNAL.test(fs.readFileSync(path.join(root, file), 'utf8')))
    .sort();
}

/** Validate the inventory against the current Media source tree. Returns error strings. */
export function checkMediaOcrConsumerInventory({ root, inventory }) {
  const errors = [];
  if (inventory?.schemaVersion !== 'media.ocr-consumer-inventory.v1') errors.push('unsupported inventory schema');
  const entries = [...(inventory?.mediaEntries ?? []), ...(inventory?.externalEntries ?? [])];
  const ids = entries.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) errors.push('duplicate inventory entry IDs');
  for (const entry of entries) {
    if (!VOCABULARY.has(entry.disposition)) errors.push(`${entry.id}: invalid disposition ${entry.disposition}`);
    if (entry.disposition !== 'DI_MIGRATED' && entry.disposition !== 'NOT_OCR' && !entry.remaining) errors.push(`${entry.id}: unresolved entry lacks remaining work`);
  }
  const declared = new Map();
  for (const entry of inventory?.mediaEntries ?? []) {
    for (const file of entry.paths ?? []) {
      if (!fs.existsSync(path.join(root, file))) {
        if (entry.disposition !== 'RETIRED') errors.push(`${entry.id}: declared path ${file} no longer exists; mark RETIRED or update the inventory`);
      } else if (entry.disposition === 'RETIRED') {
        errors.push(`${entry.id}: RETIRED path ${file} still exists`);
      }
      declared.set(file, entry);
    }
  }
  for (const file of scanMediaOcrSignals(root)) {
    if (!declared.has(file)) errors.push(`undeclared Media OCR call site or registration: ${file}`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const inventory = JSON.parse(fs.readFileSync(path.join(root, INVENTORY_PATH), 'utf8'));
  const errors = checkMediaOcrConsumerInventory({ root, inventory });
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  const counts = {};
  for (const entry of [...inventory.mediaEntries, ...inventory.externalEntries]) counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
  console.log(`PASS ${INVENTORY_PATH} accounts for every Media OCR signal (${JSON.stringify(counts)})`);
}
