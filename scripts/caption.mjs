#!/usr/bin/env node
/**
 * caption.mjs — `cvs caption`：本地词级字幕（S4-1）。
 *
 *   cvs caption <audio|video> [--model large-v3] [--device auto|cpu|cuda]
 *               [--language zh|en|auto] [--out f] [--force]
 *   cvs caption --apply <captions.json> --into <spec.json> [--replace-vo]
 *
 * 确定性纪律：ASR 每次产 caption JSON（键 = sha256(media|model|device|language)），
 * 同输入同参数直接复用缓存——非确定的识别被挡在「一次性产文件」之外；文件进
 * spec 后随 segmentHash 固化，构建依旧可复现。--into 把 segments 映射进
 * audio.vo（含词级 words[]），供旁白/字幕与 QA 词对齐消费。
 * 外部后端（Concat MCP / VoiceStudio 等）永远是子进程协议隔离，不引入依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROG = 'node scripts/caption.mjs';
const KNOWN = new Set(['model', 'device', 'language', 'out', 'force', 'apply', 'into', 'replace-vo', 'json', 'help']);

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 词级 ASR 文档 → SRT（毫秒精度）。 */
export function toSrt(doc) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const tc = (s) => { const ms = Math.round(s * 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`; };
  return (doc.segments || []).map((s, i) => `${i + 1}\n${tc(s.start)} --> ${tc(s.end)}\n${s.text}\n`).join('\n') + '\n';
}
/** SRT → WebVTT（同时间轴，逗号换点）。 */
export function toVtt(doc) { return 'WEBVTT\n\n' + toSrt(doc).replace(/,/g, '.'); }

function main() {
  const argv = process.argv.slice(2);
  const { args, unknown } = parseStrict(argv, KNOWN);
  if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);
  const mediaArg = String(argv.find((a) => !String(a).startsWith('--')) || '');

  if (args.help || (!mediaArg && !args.apply)) {
    console.log(`Usage:
  node scripts/caption.mjs <audio|video> [--model large-v3] [--device auto] [--language auto] [--out f] [--force]
  node scripts/caption.mjs --apply <captions.json> --into <spec.json> [--replace-vo]
Cache: out/captions/<sha256(media|model|device|lang)>.json — 同输入复用；--force 重识别。`);
    process.exit(args.help ? 0 : 2);
  }

  // ── --apply：captions.json → spec.audio.vo ──
  if (args.apply) {
    if (!args.into) { console.error('[error] [E_ARG] --apply 需要 --into <spec.json>'); process.exit(2); }
    let doc, specRaw;
    try { doc = JSON.parse(fs.readFileSync(path.resolve(String(args.apply)), 'utf8')); }
    catch (e) { console.error(`[error] [E_ASR_PARSE] captions 不可读: ${String(e.message).slice(0, 160)}`); process.exit(2); }
    try { specRaw = JSON.parse(fs.readFileSync(path.resolve(String(args.into)), 'utf8')); }
    catch (e) { console.error(`[error] [E_ASR_PARSE] spec 不可读: ${String(e.message).slice(0, 160)}`); process.exit(2); }
    if (!Array.isArray(doc.segments)) { console.error('[error] [E_ASR_PARSE] captions 缺 segments[]'); process.exit(2); }
    specRaw.audio = specRaw.audio || {};
    const voNew = doc.segments.map((s) => ({
      text: String(s.text || ''), start: +Number(s.start).toFixed(3),
      duration: Math.max(0.01, +(Number(s.end) - Number(s.start)).toFixed(3)),
      ...(Array.isArray(s.words) && s.words.length ? { words: s.words.map((w) => ({ w: String(w.w ?? ''), t0: +Number(w.t0).toFixed(3), t1: +Number(w.t1).toFixed(3) })) } : {}),
    })).filter((v) => v.text);
    if (!voNew.length) { console.error('[error] [E_ASR_PARSE] captions.segments 全空文本'); process.exit(2); }
    if (specRaw.audio.vo && specRaw.audio.vo.length && !args['replace-vo']) {
      console.error(`[error] [E_VO_CONFLICT] spec.audio.vo 已有 ${specRaw.audio.vo.length} 行；确认覆盖请加 --replace-vo`);
      process.exit(10);
    }
    specRaw.audio.vo = voNew;
    specRaw.audio.captionSource = { engine: doc.engine || 'faster-whisper', model: doc.model || null, mediaSha256: doc.mediaSha256 || null, appliedAt: specRaw.audio.captionSource?.appliedAt || new Date(0).toISOString() };
    const bak = String(args.into) + '.bak';
    fs.copyFileSync(path.resolve(String(args.into)), bak);
    fs.writeFileSync(path.resolve(String(args.into)), JSON.stringify(specRaw, null, 2) + '\n');
    console.error(`[caption] ${voNew.length} 行（含词级 ${voNew.filter((v) => v.words).length} 行）→ ${args.into}（备份 ${path.basename(bak)}）`);
    process.exit(0);
  }

  // ── 识别主路 ──
  const media = path.resolve(mediaArg);
  if (!fs.existsSync(media)) { console.error(`[error] [E_CAPTION_MEDIA] no such file: ${media}`); process.exit(2); }
  const model = String(args.model || 'large-v3');
  const device = String(args.device || 'auto');
  const language = String(args.language || 'auto');
  const cacheDir = path.join(ROOT, 'out', 'captions');
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = crypto.createHash('sha256').update(`${sha256(media)}|${model}|${device}|${language}|words=1|vad=1`).digest('hex').slice(0, 24);
  const cachePath = path.join(cacheDir, `${key}.json`);
  const srtPath = path.join(cacheDir, `${key}.srt`);
  const vttPath = path.join(cacheDir, `${key}.vtt`);

  let doc = null;
  if (fs.existsSync(cachePath) && !args.force) {
    try { doc = JSON.parse(fs.readFileSync(cachePath, 'utf8')); console.error(`[caption] 缓存命中 ${path.basename(cachePath)}（--force 重识别）`); } catch { doc = null; }
  } else {
    const py = process.env.PYTHON || 'python';
    const r = spawnSync(py, [path.join(HERE, 'asr_whisper.py'), '--media', media, '--model', model, '--device', device, '--language', language],
      { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 2) { console.error('[error] [E_ASR_ENV] ASR 环境缺失（详见上方 python 侧指引）'); process.exit(14); }
    if (r.status !== 0) { console.error(`[error] [E_ASR_RUN] ASR 失败 exit=${r.status}：${String(r.stderr || '').slice(-300)}`); process.exit(13); }
    try { doc = JSON.parse(String(r.stdout || '')); } catch (e) { console.error(`[error] [E_ASR_PARSE] ${String(e.message).slice(0, 160)}`); process.exit(13); }
    doc.mediaSha256 = doc.mediaSha256 || sha256(media);
    fs.writeFileSync(cachePath, JSON.stringify(doc, null, 1) + '\n');
    console.error(`[caption] 新识别 ${doc.segments?.length ?? 0} 段 → ${path.basename(cachePath)}`);
  }
  fs.writeFileSync(srtPath, toSrt(doc));
  fs.writeFileSync(vttPath, toVtt(doc));
  if (args.out) fs.copyFileSync(srtPath, path.resolve(String(args.out)));
  console.error(`[caption] ${doc.segments?.length ?? 0} 段 · lang=${doc.language} · srt=${srtPath}`);
  console.error(`[caption] 接入 spec：cvs caption --apply ${cachePath} --into <spec.json>`);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, json: cachePath, srt: srtPath, vtt: vttPath, segments: doc.segments?.length ?? 0 }) + '\n');
}

const ENTRY = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (ENTRY) main();
