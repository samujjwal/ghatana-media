// Generate the runtime schema context for the one ProductionSpec v1 descriptor.
// PDP-1 remains authoritative; this file is a deterministic build projection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PDP1_PATH = '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml';
export const OUTPUT_PATH = 'runtime-contracts/src/main/resources/contracts/media-production-spec-v1.schema.json';
const PRODUCTION_SPEC_ID = 'media.declarative.value.production-spec.v1';

export function renderProductionSpecSchemaContext(pdp1Document) {
  const context = pdp1Document?.typedProductionValueSchemaContext;
  const descriptors = pdp1Document?.typedProductionValueDescriptors;
  const descriptor = Array.isArray(descriptors)
    ? descriptors.filter(value => value?.id === PRODUCTION_SPEC_ID)
    : [];
  if (!context || context.schemaVersion !== 'media.declarative-production.typed-value-schema-context.v1' ||
      context.dialect !== 'https://json-schema.org/draft/2020-12/schema' ||
      context.sharedDefinitionsSource !== `${PDP1_PATH}#/$defs` ||
      !pdp1Document.$defs || descriptor.length !== 1 || !descriptor[0].schema) {
    throw new Error('PDP-1 production-spec schema context is missing or ambiguous');
  }
  const materialized = {
    $schema: context.dialect,
    $defs: pdp1Document.$defs,
    ...descriptor[0].schema,
  };
  return JSON.stringify(materialized, null, 2) + '\n';
}

export function renderProductionSpecSchemaContextFromYaml(sourceText) {
  const document = YAML.parseDocument(sourceText, { strict: true, uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`PDP-1 YAML parse failed: ${document.errors.map(error => error.message).join('; ')}`);
  }
  return renderProductionSpecSchemaContext(document.toJS());
}

export function verifyProductionSpecSchemaContext({
  repoRoot = root,
  sourceText = fs.readFileSync(path.join(repoRoot, PDP1_PATH), 'utf8'),
  artifactText = fs.existsSync(path.join(repoRoot, OUTPUT_PATH))
    ? fs.readFileSync(path.join(repoRoot, OUTPUT_PATH), 'utf8')
    : null,
} = {}) {
  const expected = renderProductionSpecSchemaContextFromYaml(sourceText);
  return {
    expected,
    actual: artifactText,
    matches: artifactText === expected,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes('--check');
  const result = verifyProductionSpecSchemaContext();
  if (checkOnly) {
    if (!result.matches) {
      process.stderr.write(`${OUTPUT_PATH} is missing or differs from its PDP-1 source projection\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`PASS: ${OUTPUT_PATH} matches ${PDP1_PATH}\n`);
    }
  } else {
    const target = path.join(root, OUTPUT_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.expected);
    process.stdout.write(`Wrote ${OUTPUT_PATH} from ${PDP1_PATH}\n`);
  }
}
