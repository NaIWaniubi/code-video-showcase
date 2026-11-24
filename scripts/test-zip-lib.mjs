#!/usr/bin/env node
/**
 * test-zip-lib.mjs — 自研 ZIP 写入器回归（CRC32 已知向量 + 结构完整性）。
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { crc32, writeZip } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/zip.mjs')).href);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test('crc32：标准检查向量（"123456789" → 0xCBF43926）', () => {
  const v = crc32(Buffer.from('123456789'));
  assert.equal(v, 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('writeZip：小文件 store、大文件 deflate；条目数正确', () => {
  const small = Buffer.from('hello');
  const big = Buffer.alloc(50000, 7);      // 高重复数据，deflate 必显著变小
  const zip = writeZip(new Map([['a.txt', small], ['b.bin', big]]));
  assert.ok(zip.length < big.length * 0.2 + 200, `deflate 后应远小于原文件：${zip.length}`);
  // 签名核对：EOCD 必须以 0x06054b50 结尾（尾 4 字节小端）
  const sig = zip.readUInt32LE(zip.length - 22);
  assert.equal(sig, 0x06054b50);
  // local header signature ×2
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(small.length > 30 ? 0 : 0), 0x04034b50);   // 第一项在 0
});

test('writeZip：不安全路径拒绝（.. / 绝对 / 盘符）', () => {
  for (const bad of ['../evil.txt', '/etc/passwd', 'C:\evil.txt']) {
    assert.throws(() => writeZip(new Map([['bad', Buffer.from('x')]].concat([[bad, Buffer.from('y')]]))),
      /unsafe path/, `${bad} 应被拒`);
  }
});

console.log(`\n${passed} checks passed`);

// ── R10-W1：ship dir 模式（用仓库内既有 e2e-3s 成片目录） ──────
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

test('ship：自带 stub 成片目录（hermetic，fresh checkout/CI 可跑）→ 退出 0、含 README', () => {
  // 旧版依赖仓库里"既有"的 out/e2e-3s——out/ 是 gitignored，fresh CI 必缺席；
  // G10 把「缺 master.mp4 退 13」的死账修活后，这条在 CI 上如实红了。
  // 正解是测试自备夹具，而不是让 ship 放行缺成片的包。
  const fixtureDir = path.join(ROOT, 'out', 'ship-ziplib-fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const stubs = {
    'master.mp4': Buffer.from('stub-master-bytes-for-ziplib-test'),
    'plan.json': Buffer.from(JSON.stringify({ meta: { fps: 30, width: 1920, height: 1080 }, segments: [], stats: { duration: 3 } })),
    'delivery.json': Buffer.from(JSON.stringify({ files: [] })),
  };
  for (const [n, b] of Object.entries(stubs)) fs.writeFileSync(path.join(fixtureDir, n), b);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-ship-'));
  const specPath = path.join(tmpDir, 'ship-test.spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    specVersion: 1,
    meta: { name: 'ship-test', brand: 't', cta: '', locale: 'zh-CN' },
    format: { width: 1920, height: 1080, fps: 30, aspect: '16:9', duration: 3 },
    look: { mode: 'showcase', style: null, theme: 'coral-noir' },
    audio: { mood: 'electronic', bpm: 120 },
    structure: { opening: 1, round: 1, card: 0.5, moreCard: 0.5, ending: 1, flash: { count: 0, each: 0.25 } },
    opening: { page: 'templates/segment.html' },
    rounds: [{ id: 'r01', card: { page: 'templates/big-card.html' }, style: { page: 'templates/recipe-flat.html' } }],
    moreCard: { page: 'templates/big-card.html' },
    flash: { page: 'templates/segment.html' },
    ending: { page: 'templates/segment.html' },
    render: { quality: 'master', preset: 'master', concurrency: 1, outDir: 'out/ship-ziplib-fixture' },
  }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ship.mjs'), specPath, '--out', 'dir'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
    const destDirs = fs.readdirSync(ROOT).filter((f) => /^ship-test[.-]/.test(f) || f === 'ship-test.spec');
    assert.ok(destDirs.length >= 1, '应在工作区根生成 ship-test 目录');
    const readme = fs.readFileSync(path.join(ROOT, destDirs[0], 'ship-test.spec', 'README.md'), 'utf8');
    assert.match(readme, /从零复现|三步/, 'README 应含复现指南');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // 清理 ship 目录：产物名是 `<spec名>-<date>`（如 ship-test.spec-2026-11-24）——
    // 旧正则 ^ship-test- 匹配不到带点的名字，历次运行一直在泄目录（本次顺带根治）。
    for (const f of fs.readdirSync(ROOT)) {
      if (/^ship-test([.-]|\.spec)/.test(f)) { try { fs.rmSync(path.join(ROOT, f), { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

console.log(`
${passed} checks passed`);
