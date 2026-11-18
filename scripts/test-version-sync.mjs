#!/usr/bin/env node
/**
 * test-version-sync.mjs — 版本一致性回归（R11-W4）。
 *
 * 四方必须同值：package.json / SKILL.md frontmatter / cvs --version /
 * CHANGELOG 最新条目头。任何一处漂移都算交付事故（用户看到的版本号打架）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

test('cvs --version 与 package.json 一致', () => {
  const r = spawnSync(process.execPath, ['bin/cvs.mjs', '--version'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout).trim(), pkgVersion);
});

test('SKILL.md frontmatter version 与 package.json 一致', () => {
  const fm = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const m = fm.match(/^version:\s*(\S+)/m);
  assert.ok(m, 'SKILL.md frontmatter 没有 version 字段');
  assert.equal(m[1], pkgVersion);
});

test('CHANGELOG 最新条目头与 package.json 一致', () => {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const m = cl.match(/^## \[v?([0-9]+\.[0-9]+\.[0-9]+[^\]]*)\]/m);
  assert.ok(m, 'CHANGELOG 没有版本条目头');
  assert.equal(m[1], pkgVersion);
});

console.log(`\n${passed} checks passed`);