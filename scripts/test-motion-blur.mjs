#!/usr/bin/env node
/**
 * test-motion-blur.mjs — S5a 运动模糊回归。
 *   默认只跑纯逻辑（哈希/下发/校验，秒级）；--render 追加真机子帧渲染确定性 +
 *   帧率帧数契约（需 Chrome+ffmpeg，约 1-2 分钟，手动/夜间跑）。
 * M1 plan.meta.blur 权重表生效且 renderArgs 全段下发
 * M2 开关切换必须改段哈希（缓存不可跨档位复用）
 * M3 非法档位被 E_MOTION_BLUR 拒；三档 + false 全过
 * M4 关闭态 renderArgs 干净（不带 --motion-blur，逐字节兼容既往）
 * R1 (render) 同参两跑 sha256 相同（含 tmix 后置 pass 的确定性）
 * R2 (render) 输出 ffprobe：帧数=duration*fps、帧率=fps（下游 probe/concat 契约不变）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), 'utf8'));
let fails = 0;
const ok = (n, c, note = '') => { if (c) console.log(`  ok  ${n}${note ? ` — ${note}` : ''}`); else { fails++; console.error(`  FAIL ${n}${note ? ` — ${note}` : ''}`); } };

const { buildPlanFromSpec } = await import('../templates/plan.mjs');
const { normalizeSpec, validateSpec } = await import('../templates/spec.mjs');
const planOf = (mut) => { const s = structuredClone(base); mut(s); return buildPlanFromSpec(s, { root: ROOT }).plan; };

const plain = planOf(() => {});
const blurred = planOf((s) => { s.render.motionBlur = 'normal'; });
ok('M1 meta.blur = normal weights', blurred.meta.blur === '1 2 1', String(blurred.meta.blur));
ok('M1b every segment renderArgs carries flag', blurred.segments.every((s) => s.renderArgs.includes('--motion-blur') && s.renderArgs[s.renderArgs.indexOf('--motion-blur') + 1] === '1 2 1'));
ok('M2 hash invalidated by blur toggle', blurred.segments.every((s, i) => s.hash !== plain.segments[i].hash), `${blurred.segments.length} segs all differ`);
ok('M4 off-state renderArgs clean', plain.segments.every((s) => !s.renderArgs.includes('--motion-blur')));
{
  const bad = structuredClone(base); bad.render.motionBlur = 'insane';
  const iss = validateSpec(normalizeSpec(bad));
  ok('M3 invalid level rejected', iss.some((i) => i.code === 'E_MOTION_BLUR' && i.level === 'error'));
  let anyErr = false;
  for (const v of ['weak', 'normal', 'strong', false]) {
    const s2 = structuredClone(base); s2.render.motionBlur = v;
    if (validateSpec(normalizeSpec(s2)).some((i) => i.code === 'E_MOTION_BLUR')) anyErr = true;
  }
  ok('M3b weak/normal/strong/false all accepted', !anyErr);
}

if (process.argv.includes('--render')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-blur-'));
  const seg = (out) => spawnSync(process.execPath, [path.join(ROOT, 'templates/render-segment.mjs'),
    '--page', 'templates/segment.html?theme=cyber-neon&title=blurtest&brand=CVS', '--out', out,
    '--duration', '1', '--fps', '30', '--motion-blur', '1 2 1', '--root', ROOT, '--width', '640', '--height', '360'],
  { encoding: 'utf8', timeout: 300000 });
  const a = path.join(tmp, 'a.mp4'); const b = path.join(tmp, 'b.mp4');
  const ra = seg(a); const rb = seg(b);
  ok('R1 render exit 0 ×2', ra.status === 0 && rb.status === 0, `${ra.status}/${rb.status} ${(String(ra.stderr || '').slice(-160))}`);
  if (fs.existsSync(a) && fs.existsSync(b)) {
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    ok('R1b two runs byte-identical (tmix deterministic)', sha(a) === sha(b), sha(a).slice(0, 16));
    const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0', a], { encoding: 'utf8', timeout: 60000 });
    const txt = String(pr.stdout || '');
    ok('R2 output contract: 30 frames @30fps', txt.includes('30/1') && /(^|,)30(,|$)/.test(txt.replace(/\s/g, ',')), txt.trim());
  }
  // 关闭态与既往兼容：不带 flag 渲染一次，不留 preblur 临时文件
  const c = path.join(tmp, 'c.mp4');
  const rc = spawnSync(process.execPath, [path.join(ROOT, 'templates/render-segment.mjs'),
    '--page', 'templates/segment.html?theme=cyber-neon&title=blurtest&brand=CVS', '--out', c,
    '--duration', '1', '--fps', '30', '--root', ROOT, '--width', '640', '--height', '360'], { encoding: 'utf8', timeout: 300000 });
  ok('R3 plain render untouched path ok', rc.status === 0 && fs.existsSync(c) && !fs.existsSync(c + '.preblur.mp4'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (fails) { console.error(`[test-motion-blur] ${fails} FAIL`); process.exit(1); }
console.log('[test-motion-blur] all green');
