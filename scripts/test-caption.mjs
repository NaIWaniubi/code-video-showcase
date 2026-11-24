#!/usr/bin/env node
/**
 * test-caption.mjs — S4-1 词级字幕回归（不跑真 ASR——那是重模型，CI/单测不碰；
 * 真机验收脚本单列。这里钉的是**契约层**：
 *   C1 安全 import：模块导入不执行 CLI（只导出纯函数）
 *   C2 toSrt/toVtt 时序格式（毫秒对齐 + VTT 头 + 逗号换点）
 *   C3 --apply 注入：vo 行 + words + captionSource 溯源 + .bak 备份
 *   C4 已有 vo 未 --replace-vo → E_VO_CONFLICT exit 10（拒绝静默覆盖）
 *   C5 注入产物过 validateSpec（含 E_VO_WORDS 形状闸与 W_VO_WORDS_DRIFT 跨度告警）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-cap-'));
let fails = 0;
const ok = (n, c, note = '') => { if (c) console.log(`  ok  ${n}${note ? ` — ${note}` : ''}`); else { fails++; console.error(`  FAIL ${n}${note ? ` — ${note}` : ''}`); } };

const { toSrt, toVtt } = await import('./caption.mjs');
const doc = {
  engine: 'faster-whisper', model: 'large-v3', mediaSha256: 'x'.repeat(64),
  segments: [
    { start: 0, end: 1.5, text: '你好世界', words: [{ w: '你', t0: 0, t1: 0.5 }, { w: '好', t0: 0.5, t1: 0.9 }, { w: '世界', t0: 0.9, t1: 1.5 }] },
    { start: 2, end: 3.25, text: 'second line', words: [{ w: ' second', t0: 2, t1: 2.6 }, { w: ' line', t0: 2.6, t1: 3.25 }] },
  ],
};
const srt = toSrt(doc);
ok('C2 srt timecode format', srt.includes('00:00:00,000 --> 00:00:01,500') && srt.includes('00:00:02,000 --> 00:00:03,250'));
ok('C2 srt numbering', /1\n/.test(srt) && /2\n/.test(srt));
const vtt = toVtt(doc);
ok('C2 vtt header + dot ms', vtt.startsWith('WEBVTT') && vtt.includes('00:00:01.500') && !vtt.includes(','));

// ── C3/C4/C5：--apply 行为 ──
const capPath = path.join(tmp, 'cap.json');
fs.writeFileSync(capPath, JSON.stringify(doc));
const specPath = path.join(tmp, 'spec.json');
fs.copyFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), specPath);
const CAP = path.join(ROOT, 'scripts/caption.mjs');
const r1 = spawnSync(process.execPath, [CAP, '--apply', capPath, '--into', specPath], { encoding: 'utf8', timeout: 60000 });
ok('C3 apply ok', r1.status === 0, `exit=${r1.status}`);
const spec2 = JSON.parse(fs.readFileSync(specPath, 'utf8'));
ok('C3 vo rows + words + source', spec2.audio.vo.length === 2 && spec2.audio.vo[0].words.length === 3 && spec2.audio.captionSource.engine === 'faster-whisper');
ok('C3 .bak kept', fs.existsSync(specPath + '.bak'));
const { validateSpec, normalizeSpec } = await import('../templates/spec.mjs');
const issues = validateSpec(normalizeSpec(spec2));
ok('C5 injected spec still validates', !issues.some((i) => i.level === 'error'), issues.filter((i) => i.level === 'error').map((i) => i.code).join(','));
const r2 = spawnSync(process.execPath, [CAP, '--apply', capPath, '--into', specPath], { encoding: 'utf8', timeout: 60000 });
ok('C4 re-apply blocked without --replace-vo', r2.status === 10 && String(r2.stderr).includes('E_VO_CONFLICT'), `exit=${r2.status}`);
const r3 = spawnSync(process.execPath, [CAP, '--apply', capPath, '--into', specPath, '--replace-vo'], { encoding: 'utf8', timeout: 60000 });
ok('C4b --replace-vo passes', r3.status === 0);
// 漂移词表（t 跨度远大于 duration）→ W_VO_WORDS_DRIFT
const drift = structuredClone(doc);
drift.segments[0].end = 0.6; // duration 0.6s 但词到 1.5
const driftPath = path.join(tmp, 'drift.json');
fs.writeFileSync(driftPath, JSON.stringify(drift));
const specD = path.join(tmp, 'spec-d.json');
fs.copyFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), specD);
spawnSync(process.execPath, [CAP, '--apply', driftPath, '--into', specD], { encoding: 'utf8', timeout: 60000 });
const di = validateSpec(normalizeSpec(JSON.parse(fs.readFileSync(specD, 'utf8'))));
ok('C5 word-span drift warns', di.some((i) => i.code === 'W_VO_WORDS_DRIFT'), di.map((i) => i.code).join(','));

// 形状非法词 → E_VO_WORDS
const bad = { ...doc, segments: [{ start: 0, end: 1, text: 'x', words: [{ w: 'a', t0: 2, t1: 1 }] }] };
const badPath = path.join(tmp, 'bad.json'); fs.writeFileSync(badPath, JSON.stringify(bad));
const specB = path.join(tmp, 'spec-b.json'); fs.copyFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), specB);
spawnSync(process.execPath, [CAP, '--apply', badPath, '--into', specB], { encoding: 'utf8', timeout: 60000 });
const bi = validateSpec(normalizeSpec(JSON.parse(fs.readFileSync(specB, 'utf8'))));
ok('C5 bad word shape → E_VO_WORDS', bi.some((i) => i.code === 'E_VO_WORDS'));

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`[test-caption] ${fails} FAIL`); process.exit(1); }
console.log('[test-caption] all green');
