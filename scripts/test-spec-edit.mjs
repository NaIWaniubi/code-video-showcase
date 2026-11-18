#!/usr/bin/env node
/**
 * test-spec-edit.mjs — agent 向剪辑操作核回归（R15）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const L = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/spec-edit.mjs')).href);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const base = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), 'utf8'));

test('layoutSeconds 与 fixture 总长一致（41s，结构全展开逐段）', () => {
  const lay = L.layoutSeconds(base());
  assert.equal(Math.round(lay.total * 100), 4100, `total=${lay.total}`);
  const kinds = lay.rows.map((r) => r.kind);
  assert.equal(kinds.filter((k) => k === 'opening').length, 1);
  assert.equal(kinds.filter((k) => k === 'ending').length, 1);
  assert.ok(kinds.filter((k) => k === 'card').length >= 2);   // 6 轮 × 卡+风格
});

test('splitAtSeconds：第 10s 处拆分 → 轮数 +1、D 不变、lint 过', () => {
  const s = L.splitAtSeconds(base(), 10);
  assert.equal(s.rounds.length, 7, '应变成 7 轮（原 6 + 拆出 1）');
  const lay = L.layoutSeconds(s);
  assert.equal(Math.round(lay.total * 100), 4100, '总长应保持 41s');
  // lint 验证（含 D 公式闭合）
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-s-'));
  try {
    const p = path.join(d, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(s));
    const r = spawnSync(process.execPath, ['bin/cvs.mjs', 'lint', p, '--root', ROOT],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('dropRound：丢一轮 → 轮数 -1、总长不变、lint 过', () => {
  const s = L.dropRound(base(), 'r01');
  assert.equal(s.rounds.length, 5);
  const lay = L.layoutSeconds(s);
  assert.equal(Math.round(lay.total * 100), 4100);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-d-'));
  try {
    const p = path.join(d, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(s));
    const r = spawnSync(process.execPath, ['bin/cvs.mjs', 'lint', p, '--root', ROOT],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('moveRound：换序不改总长；未知轮抛可读错误', () => {
  const s = L.moveRound(base(), 'r02', 1);
  assert.equal(s.rounds[0].id, 'r02');
  const lay = L.layoutSeconds(s);
  assert.equal(Math.round(lay.total * 100), 4100);
  assert.throws(() => L.moveRound(base(), 'nope', 1), /找不到轮/);
});

test('trimToSeconds：压到 35s → 结构重排、D=35、lint 过（每轮≥3s 保底）', () => {
  // reflow 的每轮≥3s 下限：6 轮至少需 ~21s+开销，给 35s 才能保住全部 6 轮
  const s = L.trimToSeconds(base(), 35);
  const lay = L.layoutSeconds(s);
  assert.equal(Math.round(lay.total * 100), 3500);
  assert.equal(s.rounds.length, 6);   // 轮数保留
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-t-'));
  try {
    const p = path.join(d, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(s));
    const r = spawnSync(process.execPath, ['bin/cvs.mjs', 'lint', p, '--root', ROOT],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('splitAtSeconds 越界时刻拒绝（不静默失败）', () => {
  assert.throws(() => L.splitAtSeconds(base(), 45), /不在轮区间/);
});

test('短片骨架（golden demo-skeleton 2s）：split 后 D 不变且 lint 过——整数秒地板不得破坏短片', () => {
  const skel = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/golden/demo-skeleton/spec.json'), 'utf8'));
  const before = L.layoutSeconds(skel()).total;
  const s = L.splitAtSeconds(skel(), 1);
  assert.equal(s.rounds.length, 2, '原 1 轮 + 拆出 1');
  const lay = L.layoutSeconds(s);
  assert.equal(Math.round(lay.total * 100), Math.round(before * 100), '短片总长必须保持');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-sk-'));
  try {
    const p = path.join(d, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(s));
    const r = spawnSync(process.execPath, ['bin/cvs.mjs', 'lint', p, '--root', ROOT],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// ── CLI 级钉子：bin/cvs.mjs edit（R15-W5）─────────────────────────────────

function cvsEdit(args) {
  return spawnSync(process.execPath, ['bin/cvs.mjs', 'edit', ...args],
    { cwd: ROOT, encoding: 'utf8' });
}

test('edit CLI：dry-run 默认不落盘（fixture 字节不变）+ --json ok/lintExit=0', () => {
  const fixture = path.join(ROOT, 'fixtures/mini-41s/spec.json');
  const before = sha(fs.readFileSync(fixture));
  const r = cvsEdit([fixture, '--split-at=10', '--json']);
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.edited, true);
  assert.equal(j.applied, false, '默认 dry-run');
  assert.equal(j.lintExit, 0);
  assert.equal(Math.round(j.duration * 100), 4100);
  assert.equal(sha(fs.readFileSync(fixture)), before, 'dry-run 绝不能改盘上的 spec');
});

test('edit CLI：--edl/--otio 写出行业交换格式（EDL 行 + OTIO Clip 结构）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-cli-'));
  try {
    const edl = path.join(d, 'a.edl'), otio = path.join(d, 'b.json');
    const r = cvsEdit([path.join(ROOT, 'fixtures/golden/demo-skeleton/spec.json'),
      '--split-at=1', '--edl', edl, '--otio', otio, '--json']);
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
    const edlText = fs.readFileSync(edl, 'utf8');
    assert.match(edlText, /^TITLE:/m);
    assert.ok((edlText.match(/^\d{3}  AX /gm) || []).length >= 5, 'EDL 至少 5 个事件');
    const ot = JSON.parse(fs.readFileSync(otio, 'utf8'));
    assert.equal(ot.schema_name === undefined && ot.tracks?.[0]?.children?.[0]?.schema_name, 'Clip');
    assert.ok(ot.tracks[0].children.every((c) => c.source_range && Number.isFinite(c.source_range.duration)));
  } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('edit CLI：未知轮 --drop 报错且可读（不静默）', () => {
  const r = cvsEdit([path.join(ROOT, 'fixtures/mini-41s/spec.json'), '--drop=nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr || '', /找不到轮 nope/);
});

console.log(`\n${passed} checks passed`);
