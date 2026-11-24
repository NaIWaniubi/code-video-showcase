#!/usr/bin/env node
/**
 * test-segment-edit.mjs — 帧工作台段级编辑纯核回归（R5-W7）。
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { splitSegmentAt, EditStack } = await import(pathToFileURL(path.join(ROOT, 'app/shared/segment-edit.mjs')).href);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const segs = [
  { id: '00-opening', startFrame: 0, endFrame: 60, frames: 60, duration: 2 },
  { id: 'r01-style', startFrame: 60, endFrame: 300, frames: 240, duration: 8, page: 'templates/x.html' },
];

test('分割：中点切两段，帧数守恒、id 加后缀', () => {
  const r = splitSegmentAt(segs, 180);
  assert.equal(r.ok, true);
  assert.equal(r.segments.length, 3);
  assert.equal(r.segments[1].id, 'r01-stylea');
  assert.equal(r.segments[1].endFrame, 180);
  assert.equal(r.segments[1].frames, 120);
  assert.equal(r.segments[2].id, 'r01-styleb');
  assert.equal(r.segments[2].startFrame, 180);
  assert.equal(r.segments[2].frames, 120);
  // 原数组不被原地改（不可变契约）
  assert.equal(segs.length, 2);
});

test('分割：贴边拒绝（距两端 <1 帧）', () => {
  // 61 在 r01(60..300) 内距段首 1 帧：左 1 帧右 239——按契约「≥1」合法，
  // 真正不可分的是段起点本身与只有 2 帧宽的段。
  assert.equal(splitSegmentAt(segs, 61).ok, true, '距段首恰 1 帧可切（左 1/右 239）');
  const badStart = splitSegmentAt(segs, 60);          // 帧 60 是 r01 起点
  assert.equal(badStart.ok, false, '段起点不能再分');
  const badEdge = splitSegmentAt([{ ...segs[1], endFrame: 62 }], 61);
  assert.equal(badEdge.ok, false, '只隔 2 帧的段在中间无法各留 ≥1 帧');
});

test('分割：帧号不在任何段内 → reason 可判读', () => {
  const r = splitSegmentAt(segs, 400);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'frame-not-in-segment');
  assert.deepEqual(r.segments, segs, '失败时原样返回');
});

test('duration 按 fps 折算（非硬编 30）', () => {
  const r = splitSegmentAt([{ id: 's', startFrame: 0, endFrame: 90 }], 30, 60);
  assert.equal(r.segments[0].duration, 0.5);      // 30/60s
  assert.equal(r.segments[1].duration, 1);
});

// R17-W：指针式历史链——commit / undo / redo / 分支截断 / 深拷贝 / 超限丢最旧
test('EditStack：commit 落定 → undo 回原始 → redo 回来；新编辑截断重做链', () => {
  const st = new EditStack(4);
  const s0 = [{ id: 'x', frames: 10 }, { id: 'y', frames: 20 }];
  st.commit(s0);
  assert.equal(st.canUndo, false, '未编辑过不可撤销');
  const s1 = [{ id: 'xa' }, { id: 'xb' }, { id: 'y' }];   // 一次分割后
  st.commit(s1);
  assert.equal(st.canUndo, true);
  assert.deepEqual(st.undo(), s0, 'undo 回到打开时的原始段表');
  assert.equal(st.canRedo, true);
  assert.deepEqual(st.redo(), s1, 'redo 精确恢复被撤销的状态');
  // 撤销后再编辑 → 重做链被截断
  const s2 = [{ id: 's2a' }, { id: 's2b' }];
  st.commit(s2);
  assert.equal(st.canRedo, false, '新编辑截断重做链');
  assert.deepEqual(st.undo(), s1, '回退到前一步状态（s1）');
  assert.deepEqual(st.undo(), s0, '连续撤销回到打开时的原始段表');
  assert.equal(st.canRedo, true, '重做链保留 s1 这一支');
});

test('EditStack：快照深拷贝 + 超限丢最旧（历史不受原数组后续改动影响）', () => {
  const st = new EditStack(2);
  const arr = [{ id: 'keep', startFrame: 0, endFrame: 10 }];
  st.commit(arr);
  arr[0] = { id: 'mutated-in-place' };             // 原数组就地改
  assert.equal(st.entries[0][0].id, 'keep', '快照不受原数组后续改动影响（深拷贝契约）');
  st.commit([{ id: 'a' }]);
  st.commit([{ id: 'b' }]); st.commit([{ id: 'c' }]);
  assert.equal(st.size, 2, '超限丢最旧');
  assert.equal(st.entries[0][0].id, 'b', '保留的最近两步（b、c）');
});

console.log(`\n${passed} checks passed`);
