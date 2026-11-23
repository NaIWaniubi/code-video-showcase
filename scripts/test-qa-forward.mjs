#!/usr/bin/env node
/**
 * test-qa-forward.mjs — G3-1 回归：`cvs qa --strict` 必须把 --strict 转发给
 * qa-video.mjs 与 qa-audio.py 两个子闸（HEAD 旧版只 push --plan，WARN 在子进程
 * 永远放行，help 里「warnings fail too」是空头承诺——已复现：子闸 argv 无 --strict）。
 *
 * 手法：把当前 scripts/qa.mjs 拷进临时 ROOT，配 stub 子闸把收到的 argv 落盘，
 * 断言 flag 转发；不跑真 ffprobe/python 质检（那是 qa-video/qa-audio 各自的测试域）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let fails = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok  ${name}${note ? ` — ${note}` : ''}`);
  else { fails++; console.error(`  FAIL ${name}${note ? ` — ${note}` : ''}`); }
};

// python 解释器定位（qa-audio 子闸按 env.PYTHON || 'python' 调用，stub 也用同一个）。
const PY = (() => {
  for (const cand of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) return cand;
  }
  return null;
})();
if (!PY) { console.error('  FAIL python interpreter not found (qa 音频闸的存在前提)'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-qa-fwd-'));
// stub 各按进程 env 的 STUB_DIR 落盘自己的 argv（父 spawnSync 一次注入两路可见）。
const mkHarness = () => {
  const h = path.join(tmp, 'h');
  fs.rmSync(h, { recursive: true, force: true });
  fs.mkdirSync(path.join(h, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(h, 'out'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'qa.mjs'), path.join(h, 'scripts', 'qa.mjs'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'strict-flags.mjs'), path.join(h, 'scripts', 'lib', 'strict-flags.mjs'));
  fs.writeFileSync(path.join(h, 'scripts', 'qa-video.mjs'),
    'import fs from "node:fs";\nfs.writeFileSync(process.env.STUB_DIR + "/video.json", JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n');
  fs.writeFileSync(path.join(h, 'scripts', 'qa-audio.py'),
    'import json,os,sys\nopen(os.environ["STUB_DIR"]+"/audio.json","w").write(json.dumps(sys.argv[1:]))\n');
  fs.writeFileSync(path.join(h, 'out', 'master.mp4'), 'x');
  fs.writeFileSync(path.join(h, 'out', 'plan.json'), JSON.stringify({ segments: [] }));
  return h;
};
const qaRun = (extra) => {
  const h = mkHarness();
  const r = spawnSync(process.execPath, [path.join(h, 'scripts', 'qa.mjs'), ...extra], {
    cwd: h, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PYTHON: PY, STUB_DIR: h.replace(/\\/g, '/') },
  });
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(h, f), 'utf8')); } catch { return null; } };
  return { code: r.status, video: read('video.json'), audio: read('audio.json') };
};

// ── 1) 带 --strict：两个子闸都必须收到 --strict ──
{
  const { code, video, audio } = qaRun(['out/master.mp4', '--strict']);
  ok('video gate receives --strict', Array.isArray(video) && video.includes('--strict'), JSON.stringify(video));
  ok('audio gate receives --strict', Array.isArray(audio) && audio.includes('--strict'), JSON.stringify(audio));
  ok('plan still forwarded alongside', !!video && video.includes('--plan') && !!audio && audio.includes('--plan'));
  ok('qa汇总 exit 0 when stubs pass', code === 0, `exit=${code}`);
}
// ── 2) 不带 --strict：不许偷加 ──
{
  const { video, audio } = qaRun(['out/master.mp4']);
  ok('no --strict leak into video gate', Array.isArray(video) && !video.includes('--strict'), JSON.stringify(video));
  ok('no --strict leak into audio gate', Array.isArray(audio) && !audio.includes('--strict'), JSON.stringify(audio));
}
// ── 3) 子闸 FAIL 透传：stub exit 1 → qa 13（qa 族退出码不变） ──
{
  const h = mkHarness();
  fs.writeFileSync(path.join(h, 'scripts', 'qa-video.mjs'), 'process.exit(1);\n');
  const r = spawnSync(process.execPath, [path.join(h, 'scripts', 'qa.mjs'), 'out/master.mp4', '--strict'],
    { cwd: h, encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHON: PY, STUB_DIR: h.replace(/\\/g, '/') } });
  ok('child FAIL -> qa exit 13', r.status === 13, `exit=${r.status}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`[test-qa-forward] ${fails} FAIL`); process.exit(1); }
console.log('[test-qa-forward] all green');
