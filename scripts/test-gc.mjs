#!/usr/bin/env node
/**
 * test-gc.mjs — G6-4 缓存回收的回归。用 tmp 假缓存目录，绝不动真 out/。
 * 钉死：只删 .cache 下的 mp4+json 对；非 .cache 目录被护栏拒；stray 文件不碰；
 * --keep/--older-than 语义；无策略时只 dry-run。零依赖。退出码 0/1。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GC = path.join(ROOT, 'scripts/gc.mjs');
let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); passed++; console.log('✓ ' + n); } catch (e) { failed++; console.error('✗ ' + n + '\n  ' + (e.message || e)); process.exitCode = 1; } };

function mkCache(entries) {
  // entries: [{base, ageDays}] → 造 <tmp>/.cache/<base>.mp4 + .json，按 age 设 mtime
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-gc-'));
  const cache = path.join(dir, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  for (const { base, ageDays } of entries) {
    const mp4 = path.join(cache, base + '.mp4');
    fs.writeFileSync(mp4, 'x'.repeat(1000 + base.length));
    fs.writeFileSync(path.join(cache, base + '.json'), JSON.stringify({ base }));
    const when = Date.now() - (ageDays || 0) * 86400000;
    fs.utimesSync(mp4, new Date(when), new Date(when));
    fs.utimesSync(path.join(cache, base + '.json'), new Date(when), new Date(when));
  }
  return { dir, cache };
}
function run(args) {
  return spawnSync(process.execPath, [GC, ...args], { encoding: 'utf8', cwd: ROOT });
}
function readJson(r) { return JSON.parse(r.stdout.trim()); }

test('护栏：目标 basename 非 .cache 时拒绝（exit 2），不删任何文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-gc-deliv-'));
  fs.writeFileSync(path.join(dir, 'master.mp4'), 'master-bytes');
  const r = run(['--cache', dir, '--keep', '0', '--json']);
  assert.equal(r.status, 2, 'non-.cache dir must be refused');
  assert.ok(fs.existsSync(path.join(dir, 'master.mp4')), 'deliverable must survive the guard');
  assert.match(readJson(r).error, /\.cache/);
});

test('--keep 0 清空 .cache 的 mp4+json 对（护栏内目录）', () => {
  const { cache } = mkCache([{ base: 'aaaa' }, { base: 'bbbb' }, { base: 'cccc' }]);
  const before = fs.readdirSync(cache).length;
  assert.equal(before, 6, '3 entries = 6 files');
  const r = run(['--cache', cache, '--keep', '0', '--json']);
  assert.equal(r.status, 0);
  const j = readJson(r);
  assert.equal(j.deletedFiles, 6, `expected 6 files deleted, got ${j.deletedFiles}`);
  assert.equal(fs.readdirSync(cache).length, 0, 'cache should be empty');
});

test('--keep 2 只保留最新 2 个，删较旧 1 个', () => {
  const { cache } = mkCache([{ base: 'new1', ageDays: 0 }, { base: 'new2', ageDays: 0 }, { base: 'old', ageDays: 30 }]);
  const r = run(['--cache', cache, '--keep', '2', '--json']);
  const j = readJson(r);
  assert.equal(j.toDelete, 1);
  assert.ok(fs.existsSync(path.join(cache, 'new1.mp4')) && fs.existsSync(path.join(cache, 'new2.mp4')), 'newest kept');
  assert.ok(!fs.existsSync(path.join(cache, 'old.mp4')), 'oldest deleted');
  assert.ok(!fs.existsSync(path.join(cache, 'old.json')), 'paired json deleted too');
});

test('--older-than 14 删 30 天前的、留 1 天前的', () => {
  const { cache } = mkCache([{ base: 'fresh', ageDays: 1 }, { base: 'stale', ageDays: 30 }]);
  const r = run(['--cache', cache, '--older-than', '14', '--json']);
  assert.equal(readJson(r).toDelete, 1);
  assert.ok(fs.existsSync(path.join(cache, 'fresh.mp4')) && !fs.existsSync(path.join(cache, 'stale.mp4')));
});

test('无 --keep/--older-than 时只 dry-run，一文件不删', () => {
  const { cache } = mkCache([{ base: 'a' }, { base: 'b' }]);
  const r = run(['--cache', cache, '--json']);
  const j = readJson(r);
  assert.equal(j.dryRun, true, 'must be dry-run when no policy given');
  assert.equal(j.deletedFiles, 0);
  assert.equal(fs.readdirSync(cache).length, 4, 'nothing deleted');
});

test('--dry-run 报告 reclaim 字节但不删', () => {
  const { cache } = mkCache([{ base: 'x' }, { base: 'y' }]);
  const r = run(['--cache', cache, '--keep', '0', '--dry-run', '--json']);
  const j = readJson(r);
  assert.equal(j.dryRun, true);
  assert.ok(j.reclaimBytes > 0, 'reclaim bytes reported');
  assert.ok(fs.existsSync(path.join(cache, 'x.mp4')), 'dry-run deletes nothing');
});

test('stray 文件（非 mp4/json）不动；孤儿 json 计入可回收', () => {
  const { cache } = mkCache([{ base: 'p' }]);
  fs.writeFileSync(path.join(cache, 'README.keep'), 'do not touch');       // stray
  fs.writeFileSync(path.join(cache, 'dangling.json'), '{}');               // 孤儿 json，无配对 mp4
  const r = run(['--cache', cache, '--keep', '0', '--json']);
  const j = readJson(r);
  assert.equal(j.stray, 1);
  assert.ok(fs.existsSync(path.join(cache, 'README.keep')), 'stray untouched');
  assert.ok(!fs.existsSync(path.join(cache, 'dangling.json')), 'orphan json reclaimed');
  assert.ok(!fs.existsSync(path.join(cache, 'p.mp4')));
});

test('knobs 后缀缓存（G2 <hash>.k<fp>.mp4）按 basename 正确配对删除', () => {
  const { cache } = mkCache([{ base: 'hash1.kabc123def' }, { base: 'hash2' }]);
  const r = run(['--cache', cache, '--keep', '1', '--json']);
  assert.equal(readJson(r).toDelete, 1);
  // 两者之一被删，剩一个 mp4+json
  const left = fs.readdirSync(cache).filter((f) => f.endsWith('.mp4'));
  assert.equal(left.length, 1);
});

test('缓存不存在 → exit 2 且不崩', () => {
  const r = run(['--cache', path.join(os.tmpdir(), 'definitely-not-here-' + Date.now(), '.cache')]);
  assert.equal(r.status, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
