import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => readFileSync(resolve(root, p), 'utf8');
test('Gradle buildAll delegates to full Media polyglot Build', () => {
  const source = read('build.gradle.kts');
  assert.match(source, /tasks\.register\("buildAll"\)[\s\S]*?dependsOn\("buildFull"\)/u);
  assert.match(source, /tasks\.register\("buildFull"\)[\s\S]*?dependsOn\("buildMediaJvm", "buildPnpm", "buildCargo"\)/u);
  assert.match(source, /tasks\.register\("buildMediaJvm"\)[\s\S]*?it\.path\.startsWith\(":services:media:"\)/u);
  assert.match(source, /it\.buildFile\.isFile/u);
});
test('Media pnpm build excludes unrelated sibling workspaces', () => {
  const source = read('build.gradle.kts');
  const index = source.indexOf('tasks.register<Exec>("buildPnpm")');
  const end = source.indexOf('tasks.register<Exec>("buildCargo")', index);
  const section = source.slice(index, end);
  assert.ok(section.includes('"--filter", "./apps/**"'));
  assert.ok(section.includes('"--filter", "./libs/**"'));
  assert.ok(section.includes('"--filter", "./modules/**"'));
  assert.doesNotMatch(section, /commandLine\("pnpm", "-r", "build"\)/u);
});
