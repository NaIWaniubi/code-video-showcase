#!/usr/bin/env node
/**
 * test-blur-cli.mjs — G6 blur 打磨的回归（纯逻辑）。
 * 钉死：--motion-blur off/none/false/0 是合法关闭档（此前只认 JSON false，
 * 命令行 off 撞 E_MOTION_BLUR，与 --transition none 不对称）；资源上限按子帧倍率放大。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../templates/spec.mjs';
import { isMotionBlurOff } from '../templates/transitions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); passed++; console.log('✓ ' + n); } catch (e) { failed++; console.error('✗ ' + n + '\n  ' + (e.message || e)); process.exitCode = 1; } };

const baseSpec = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), 'utf8'));
const codesFor = (s) => validateSpec(s, ROOT).filter((i) => i.level === 'error').map((i) => i.code);

test('isMotionBlurOff：off/none/false/0/undefined/JSON false 全判关，weak/normal/strong 判开', () => {
  for (const v of ['off', 'OFF', 'none', 'false', '0', false, undefined, null, '']) assert.ok(isMotionBlurOff(v), `${JSON.stringify(v)} should be off`);
  for (const v of ['weak', 'normal', 'strong']) assert.ok(!isMotionBlurOff(v), `${v} should be on`);
});

test('validateSpec：motionBlur 写 off/none/false 不再报 E_MOTION_BLUR；bogus 仍报', () => {
  for (const v of [false, 'off', 'none', 'false', '0']) {
    const s = baseSpec();
    s.render = { ...s.render, motionBlur: v };
    assert.ok(!codesFor(s).includes('E_MOTION_BLUR'), `motionBlur=${JSON.stringify(v)} must be accepted`);
  }
  const bad = baseSpec();
  bad.render = { ...bad.render, motionBlur: 'bogus' };
  assert.ok(codesFor(bad).includes('E_MOTION_BLUR'), 'bogus tier must still fail');
});

test('G6-3：资源上限按子帧倍率放大——基线贴顶的 spec 开 strong 档必须被拦', () => {
  // mini-41s 是 41s@30fps（1230 帧）；把时长拉到 599s：基线 17970 帧 ≤ 18000 放行，
  // ×strong(5) = 89850 帧 > 18000 → E_DURATION_MAX。此前无倍率项，顶格+strong≈700GB
  // raw 通道静默超卖（审计 F11）。
  const ok = baseSpec();
  ok.format = { ...ok.format, duration: 599, fps: 30 };
  assert.ok(!codesFor(ok).includes('E_DURATION_MAX'), '599s@30fps without blur stays under the frame budget');
  const on = baseSpec();
  on.format = { ...ok.format };
  on.render = { ...on.render, motionBlur: 'strong' };
  const codes = codesFor(on);
  assert.ok(codes.includes('E_DURATION_MAX'), '×5 subframe sampling must trip the scaled frame budget');
});

test('G6-3 报错文案指认 blur 档位与倍率（用户能自救）', () => {
  const s = baseSpec();
  s.format = { ...s.format, duration: 599, fps: 30 };
  s.render = { ...s.render, motionBlur: 'strong' };
  const issue = validateSpec(s, ROOT).find((i) => i.code === 'E_DURATION_MAX');
  assert.match(issue.message, /×5 motion-blur\(strong\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
