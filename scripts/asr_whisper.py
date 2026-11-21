#!/usr/bin/env python
"""
asr_whisper.py — `cvs caption` 的本地词级 ASR 适配器（faster-whisper）。

设计纪律（CVS 确定性契约的外围）：
  * 本脚本**只在显式调用时跑**；结果由 caption.mjs 按 (media sha256 | model | 参数)
    缓存成 JSON 落盘——ASR 的非确定性被隔离在「一次性产文件」层，
    文件一旦成为 spec/plan 输入就进哈希，构建依旧可复现。
  * 只读音频不写旁路文件；stdout 只出 JSON，日志走 stderr。
  * GPU 不可用自动回退 CPU（int8），与留声链路同款策略。
用法：
  python asr_whisper.py --media <path> [--model large-v3] [--device auto] \
      [--language auto] [--json out.json]
退出码：0 成功 · 2 环境缺失（python 包/模型不可得，交上层给可读指引） · 3 运行失败
"""
import argparse
import hashlib
import json
import sys


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def sha256_file(p, cap=1 << 30):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
            cap -= len(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--media', required=True)
    ap.add_argument('--model', default='large-v3')
    ap.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda'])
    ap.add_argument('--language', default='auto')
    ap.add_argument('--json', dest='json_out', default='')
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except Exception as e:  # noqa: BLE001
        eprint(f'[asr] [E_ASR_ENV] faster-whisper 不可导入: {e}')
        eprint('[asr] 安装：pip install faster-whisper（模型首次运行自缓存；离线机用 HF_HOME 预置）')
        sys.exit(2)

    device = args.device
    compute = 'int8'
    if device == 'auto':
        try:
            import torch  # type: ignore
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
        except Exception:  # noqa: BLE001
            device = 'cpu'
    eprint(f'[asr] model={args.model} device={device} compute={compute}')

    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device=device, compute_type=compute)
        lang = None if args.language == 'auto' else args.language
        segments, info = model.transcribe(
            args.media, language=lang, word_timestamps=True, vad_filter=True, beam_size=5)
        out_segs = []
        for s in segments:
            words = [{'w': w.word, 't0': round(float(w.start), 3), 't1': round(float(w.end), 3)}
                     for w in (s.words or []) if w.word and w.word.strip()]
            out_segs.append({
                'start': round(float(s.start), 3),
                'end': round(float(s.end), 3),
                'text': s.text.strip(),
                'words': words,
            })
            eprint(f'[asr] [{s.start:7.2f} → {s.end:7.2f}] {s.text.strip()[:60]}')
    except Exception as e:  # noqa: BLE001
        eprint(f'[asr] [E_ASR_RUN] {type(e).__name__}: {e}')
        sys.exit(3)

    doc = {
        'engine': 'faster-whisper',
        'model': args.model,
        'device': device,
        'language': getattr(info, 'language', lang) or 'unknown',
        'languageProbability': round(float(getattr(info, 'language_probability', 0) or 0), 4),
        'mediaSha256': sha256_file(args.media),
        'wordTimestamps': True,
        'segments': out_segs,
    }
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text + '\n')
        eprint(f'[asr] wrote {args.json_out}')
    else:
        print(text)


if __name__ == '__main__':
    main()
