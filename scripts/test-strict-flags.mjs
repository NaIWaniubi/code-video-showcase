#!/usr/bin/env node
/**
 * test-strict-flags.mjs — R3-审计（RT-04 #1 / RT-09 F#）：严格 flag 解析回归。
 *
 *   node scripts/test-strict-flags.mjs
 *
 * 背景：deliver / versions / plan / render-farm / render-batch 的宽容解析器曾让
 * `--strik`、`--coer` 一律静默吞掉并 exit 0——「忘加 --strict」被当成成功结论。
 * parseStrict + rejectUnknown 是它们的共同入口，这里钉死语义。
 */
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const { parseStrict, suggestFlag } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/strict-flags.mjs')).href);

test('解析：无值 flag → true，后跟 -- 的值不吞', () => {
  assert.deepEqual(parseStrict(['--resume'], new Set(['resume'])).args, { resume: true });
  assert.deepEqual(parseStrict(['--resume', '--quiet'], new Set(['resume', 'quiet'])).args,
    { resume: true, quiet: true });
});

test('解析：带值 flag 取下一个 token；值本身以 -- 开头不当值', () => {
  assert.deepEqual(
    parseStrict(['--spec', 'project.spec.json'], new Set(['spec'])).args,
    { spec: 'project.spec.json' });
  assert.deepEqual(
    parseStrict(['--out', '--json'], new Set(['out', 'json'])).args,
    { out: true, json: true });
});

test('解析：未知 flag 收进 unknown，不当参数吞', () => {
  const r = parseStrict(['--spec', 'a.json', '--strik', '--concurr'], new Set(['spec']));
  assert.equal(r.args.spec, 'a.json');
  assert.deepEqual(r.unknown, ['strik', 'concurr']);
});

test('解析：裸位置参数（原样跳过，不拦子命令）', () => {
  assert.deepEqual(parseStrict(['rollback', 'v001', '--spec', 'x.json'],
    new Set(['spec'])).args, { spec: 'x.json' });
});

test('建议：编辑距离 ≤3 给 did-you-mean，超出返回 null', () => {
  assert.equal(suggestFlag('specx', ['spec', 'out']), 'spec');
  assert.equal(suggestFlag('labell', ['label']), 'label');
  assert.equal(suggestFlag('outdirr', ['outdir']), 'outdir');
  assert.equal(suggestFlag('strik', ['stagger', 'resume']), null);
  assert.equal(suggestFlag('zzzzz', ['spec']), null);
});

console.log(`\n${passed} checks passed`);