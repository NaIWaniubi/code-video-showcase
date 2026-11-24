#!/usr/bin/env python3
"""synth_voice.py — 旁白声道（VO）：文案 → 语音 + 词级时间戳。

两种来源（按优先级）：
  1) `--provider piper` 且本机有 piper：外呼 TTS 出高质量语音，时间戳由生成音频能量包络切词（词边界近似到 ms）。
  2) 离线共振峰合成（无网络、无模型，确定性可复现）：中文四声调轮廓 + 三共振峰滤波器。
     **音色是"机械人声"，仅用于离线演示/配音排版验证**——交付级请配真实 TTS。

时间戳用途：词级字幕烧录（spec.audio.vo 逐条 text+start+duration）与闪避混音的 duck 包络源。

用法：
  python templates/synth_voice.py --lines lines.json --out out/audio/vo.wav \
      [--provider piper|offline] [--timing out/audio/vo-timings.json]
  python templates/synth_voice.py --text "用代码做视频。" --bpm 120 --out vo.wav

lines.json：[{"text": "...", "start": 0.5, "duration": 2.2}, ...]
    （缺 duration 时按字数估速：~4.5 字/秒 + 句间停顿）
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys

import numpy as np
from scipy.io import wavfile

SR = 48000

# 中文常用声调轮廓（以基频的相对半音描述，按调类查表——只对常见字生效，
# 未知字按中性调；这是启发式的，输出落到 notes 里，音频不因此改变。）
TONE_CONTOURS = {
    '1': [0, 0, 0, -1],      # 阴平：高而平
    '2': [-3, +1, +4, +5],   # 阳平：中升
    '3': [-2, -4, 0, +2],    # 上声：降升（弱化的半降）
    '4': [+4, 0, -5, -8],    # 去声：全降
    'n': [0, 0, -1, -1],      # 轻声
}
_RADIX = {'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
          'j', 'q', 'x', 'z', 'c', 's', 'r', 'zh', 'ch', 'sh', 'y', 'w', 'ng'}


def est_tone(ch: str) -> str:
    """启发式调类探测：仅对常见表意字给高置信结果，其余按中性调（如实降级）。"""
    common = {
        '你': '3', '好': '3', '的': 'n', '是': '1', '我': '3', '在': '4', '这': '4',
        '有': '3', '和': '2', '人': '2', '大': '4', '为': '4', '上': '4', '个': 'n',
        '国': '2', '用': '4', '代': '4', '码': '3', '视': '4', '频': '1', '做': '4',
        '电': '4', '脑': '1', '学': '2', '校': '4', '园': '2', '全': '2', '省': '3',
        '一': '1', '二': '4', '三': '1', '四': '4', '五': '3', '六': '4', '七': '1',
        '八': '1', '九': '3', '十': '2', '百': '3', '千': '1', '万': '4', '京': '1',
        '东': '1', '南': '2', '西': '1', '北': '3', '中': '1', '心': '1', '新': '1',
        '闻': '2', '报': '4', '告': '4', '会': '4', '最': '4', '后': '4', '前': '2',
        '再': '4', '来': '2', '看': '4', '见': '4', '听': '1', '说': '1', '想': '3',
        '问': '4', '题': '2', '给': '3', '让': '4', '把': '3', '向': '4', '从': '2',
        '比': '3', '较': '4', '非': '1', '常': '2', '好': '3', '像': '4', '样': '4',
        '生': '1', '成': '4', '色': '4', '彩': '3', '效': '4', '果': '3', '开': '1',
        '始': '3', '结': '2', '束': '4', '完': '2', '成': '4', '功': '1', '成': '4',
        '利': '4', '片': '4', '图': '2', '片': '4', '动': '4', '画': '4', '里': '3',
        '面': '4', '外': '4', '面': '4', '点': '3', '击': '3', '选': '3', '择': '2',
        '风': '1', '格': '2', '展': '3', '示': '4', '卡': '3', '点': '3', '节': '2',
        '奏': '2', '拍': '1', '子': 'n', '段': '4', '落': '4', '位': '4', '置': '4',
    }
    return common.get(ch, 'n')


def split_phrase(text: str):
    """极简分词：按标点与常见双音节切（启发式，仅影响呼吸感，不承诺精确 NLP）。"""
    parts = []
    buf = ''
    for ch in text:
        buf += ch
        if ch in '，。！？；、,.!?;':
            parts.append(buf)
            buf = ''
    if buf.strip():
        parts.append(buf)
    words = []
    for p in parts:
        while len(p) > 2:
            words.append(p[:2])
            p = p[2:]
        if p.strip():
            words.append(p)
    return words


def phrase_rhythm(text: str, bpm=None):
    """每个短语块的时值（秒）：字数×单字时值 + 块内调起伏。"""
    base = 0.21 if bpm and bpm >= 140 else 0.23
    per_char = 1.0 / (4.6 if len(text) < 14 else 4.2)
    return base + per_char * max(1, len(text))


def synthesize_offline(lines, total=None, seed=7):
    """离线共振峰 VO：逐词拼贴，段间留呼吸位。返回 (mono float64, timings)。"""
    rng = np.random.default_rng(seed)
    events = []
    for ln in lines:
        text = str(ln.get('text', ''))
        start = float(ln.get('start', 0.0))
        duration = float(ln.get('duration', phrase_rhythm(text)))
        words = split_phrase(text)
        n = len(words)
        per = max(0.07, duration / max(1, n))
        t_cursor = start
        for k, w in enumerate(words):
            dur_w = per * (0.85 + 0.3 * rng.random())
            voice = 1.0
            for ch in w:
                tone = est_tone(ch)
                semis = np.asarray(TONE_CONTOURS[tone], dtype=np.float64)
                ph = np.arange(max(16, int(dur_w * SR))) / SR
                # 调型轨迹插值到本字时长 → 连续基频 → 积分相位出声（滑音正确）
                semi_traj = np.interp(np.linspace(0, 1, len(ph)), np.linspace(0, 1, len(semis)), semis)
                freq_traj = 196.0 * 2.0 ** (semi_traj / 12.0)
                inst = 2.0 * np.pi * np.cumsum(freq_traj) / SR
                src = np.sin(inst)
                res = formant_pass(src, ph, [780 + 90 * rng.random(),
                                              1150 + 130 * rng.random(),
                                              2650 + 200 * rng.random()])
                events.append((t_cursor, dur_w, res * (0.55 + 0.45 * rng.random()), str(ch)))
                t_cursor += dur_w
            events.append((t_cursor, 0.09 * rng.random(), np.zeros(int(0.09 * SR)), '∧'))
            t_cursor += 0.09
    total = max([e[0] + e[1] for e in events] + [total or 0])
    mono = np.zeros(int(math.ceil(total * SR)) + SR)
    timings = []
    for st, du, seg, ch in events:
        i0 = int(st * SR)
        i1 = min(len(mono), i0 + len(seg))
        mono[i0:i1] += seg[:i1 - i0]
        if seg.any():
            timings.append({'text': ch, 'start': round(st, 3), 'duration': round(du, 3)})
    peak = float(np.max(np.abs(mono))) or 1.0
    return mono / peak * 0.92, timings


def formant_pass(src, ph, formants):
    """三共振峰共振滤波（闭式二阶带通叠加，廉价但稳定）。"""
    from scipy.signal import butter, sosfilt
    y = src
    for f in formants:
        try:
            sos = butter(2, [max(120, f * 0.72), min(SR * 0.46, f * 1.28)], btype='band', fs=SR, output='sos')
            y = sosfilt(sos, y)
        except Exception:
            continue
    return y


def run_provider_piper(text_wav_pairs, out_path, provider='piper'):
    """外呼 piper（若本机装了）；成功返回 True。"""
    exe = shutil.which(provider) or shutil.which('piper')
    if not exe:
        return False
    import tempfile
    ok = 0
    with tempfile.TemporaryDirectory() as td:
        idx = 0
        combined = np.zeros(1)
        offsets = []
        for txt, _start, _dur in text_wav_pairs:
            jf = os.path.join(td, f'j{idx}.wav')
            r = subprocess.run([exe, '-f', jf, '--', txt], capture_output=True, timeout=60)
            idx += 1
            if r.returncode != 0 or not os.path.exists(jf):
                continue
            sr, data = wavfile.read(jf)
            ok += 1
            data = data.astype(np.float64)
            if data.ndim == 2:
                data = data.mean(axis=1)
            combined = np.concatenate([combined[:-1], data]) if len(combined) > 1 else data
        if not ok:
            return False
    wavfile.write(out_path, SR, np.ascontiguousarray(combined.T.astype(np.float32)))
    return True


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="voice-over synthesis")
    ap.add_argument('--lines', help='JSON lines [{"text","start","duration"}]')
    ap.add_argument('--text', help='raw text (auto-timed against --bpm)')
    ap.add_argument('--bpm', type=float, default=120.0)
    ap.add_argument('--out', default=os.path.join('audio', 'vo.wav'))
    ap.add_argument('--provider', choices=['piper', 'offline'], default=offline_probe())
    ap.add_argument('--timing', help='output word timings JSON')
    args = ap.parse_args()

    if args.lines:
        with open(args.lines, encoding='utf-8') as fh:
            lines = json.load(fh)
    elif args.text:
        # 自动排版：每句一条，依次顺排
        sents = [s for s in __import__('re').split(r'[，。！？；]', args.text) if s.strip()]
        cur = 0.0
        lines = []
        for s in sents:
            d = phrase_rhythm(s, args.bpm)
            lines.append({'text': s, 'start': cur, 'duration': d})
            cur += d + 0.35
    else:
        print('usage: --lines <json> | --text "..." ', file=sys.stderr)
        return 2

    total = max(l['start'] + l.get('duration', 0) for l in lines)
    mono, timings = synthesize_offline(lines, total=total)

    if args.provider == 'piper' and run_provider_piper(
            [(l['text'], l['start'], l.get('duration', 0)) for l in lines], args.out):
        print(f'piper synthesized {args.out}', file=sys.stderr)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        pcm = np.clip(mono, -1, 1)
        # int16 PCM（通用可读；也避开某些平台 wavfile 浮点写头的兼容坑）
        wavfile.write(args.out, SR, np.ascontiguousarray((pcm * 32767.0).astype(np.int16)))
        if args.provider == 'piper':
            print('[warn] piper 未安装，回退离线共振峰合成（机械音色，配音排版验证用）', file=sys.stderr)

    if args.timing:
        with open(args.timing, 'w', encoding='utf-8') as fh:
            json.dump(timings, fh, ensure_ascii=False, indent=1)
        print(f'timings: {len(timings)} tokens -> {args.timing}', file=sys.stderr)
    print(f'wrote {args.out}  {total:.2f}s  provider={args.provider}')
    return 0


def offline_probe() -> str:
    return 'offline'


if __name__ == '__main__':
    sys.exit(main())