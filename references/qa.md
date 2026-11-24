# QA gate（v2.9）

两道闸：**视频** `scripts/qa-video.mjs`，**音频** `scripts/qa-audio.py`。都输出 JSON，可直接进 CI。

```bash
node scripts/qa-video.mjs out/master.mp4 --plan out/plan.json
python scripts/qa-audio.py out/audio/mix.wav --plan out/plan.json --strict   # 或直测成片 mp4
```

三档语义：`FAIL` 一律拦交付；`WARN` 仅 `--strict` 下拦；`ADVISORY`（VMAF 未装、联系表失败等）永不拦。

## 1. 视频检查

| 检查 | 工具 | 通过条件 | 级别 |
|---|---|---|---|
| codec | ffprobe | h264 | WARN |
| pix_fmt | ffprobe | yuv420p | FAIL |
| 尺寸 | ffprobe | 与 plan 的 `meta.width/height` 一致 | FAIL |
| fps | ffprobe | `30/1`（或 plan 值） | WARN |
| 帧数 | 容器元数据优先，必要时 `-count_frames` | 等于 `plan.stats.frames` | FAIL |
| 色彩标记 | ffprobe | `bt709/bt709/bt709/tv` | WARN |
| 时长 | ffprobe | 与 plan 差 ≤ 1 帧 | WARN |
| 音频 | ffprobe | AAC 48 kHz 2ch | WARN |
| 黑帧 | `blackdetect=d=0.10:pic_th=0.98:pix_th=0.10` | 总黑 ≤ max(0.5 s, 1%)（转场窗裁剪后累计） | WARN |
| 冻结帧 | `freezedetect=n=0.001:d=1.0` | 卡片/闪白窗口之外无 >1 s 静止 | WARN |
| 静音 | `silencedetect=noise=-45dB:d=1.0` | 片中无 >1 s 静音 | WARN |
| 闪烁 | signalstats YAVG 全画面亮度摆率 | ≤3 对/s（WCAG 2.3.1，幅度 ΔL≥0.1） | WARN |
| GOP 间距 | ffprobe I 帧时间戳最大间隔 | ≤ keyint 2×fps + 1 帧容差（约 ≤2.03 s@30fps，平台不强制二转） | WARN |
| 响度 | `loudnorm print_format=json` | −14 ±1 LUFS；**8× 过采样真峰** ≤ −1.0 dBTP；LRA ≤ 14 | WARN |
| VMAF | `libvmaf`（可选，需 `--ref` 同长母版） | mean ≥ `--min-vmaf`（默认 95） | FAIL（min 只报告不设闸） |
| 联系表 | ffmpeg tile | `qa/contact.jpg` 生成 | ADVISORY |

带 `--plan` 时另有内容级检查：页面存在性、占位页文案、copy 存在，以及**检查齐全性断言**
（R3）：必备项没跑成（如 probe 失败整项缺席）与「跑过了没问题」严格分开，缺项直接 FAIL——
不再出现「ffmpeg 构建差异即可假绿」的缝隙。

`--strict` 把所有 WARN 升级为 exit 1。默认只在 FAIL 时 exit 1。

VMAF 的参考片必须是 **CRF 12/无损中间片**，不要拿平台成品互比；否则分数没有意义。

## 2. 音频检查

| 检查 | 方法 | 通过条件 |
|---|---|---|
| 真峰 | **8× 过采样 dBTP**（不是采样峰） | contract 级 ≤ −1.0 dBTP（WARN 超限） |
| 削波 | `abs(x) ≥ 0.999` | 0 samples（FAIL） |
| 整体响度 | BS.1770 K-weighting + gating | −14 ±1 LUFS（WARN） |
| 位深 | 文件头 sampwidth（含 EXTENSIBLE 手工解） | 按实际位宽归一，不猜幅值 |
| 速度 | 谱通量包络自相关（八度归一 + conf 地板） | 与 plan BPM 差 ≤ 2（WARN） |
| 拍网格 | 锚定 plan 声明的 subdiv；命中率**能量加权**（与 offset 搜索同准则），无加权计数随报告输出 | ≥70%（WARN） |
| cue 对齐 | plan.audio.cues 最近 onset | 有 onset 覆盖的 cue 中 ≥80% 在 ±30 ms（覆盖率只报告） |
| 静音 | 50 ms 窗 RMS < −45 dB | 无 ≥1 s 段（WARN） |
| 高频克制 | 8–16 kHz 能量 | 关键窗口比其余高 ≥6 dB（WARN） |

`--plan` 必须存在：缺失 → E_PLAN_MISSING exit 2；合法 JSON 但缺 `audio.bpm/cues` → E_PLAN_INCOMPLETE exit 2。
cue / tempo / HF 三道 gate 无 plan 即无法执行，绝不静默假绿。

`qa-audio.py` 只需要 numpy/scipy；频谱图纯 numpy + zlib 写 PNG（不依赖 matplotlib）。

## 3. 报告结构

`qa/qa-video.json`：

```json
{
  "expect": { "width": 1920, "height": 1080, "fps": 30, "frames": 1830 },
  "metrics": { "frames": 1830, "codec": "h264", "pix_fmt": "yuv420p",
               "black": {}, "freeze": {}, "silence": {}, "flash": {},
               "gop": {}, "loudness": { "lufs": -13.9, "truePeak": -1.7 } },
  "checks": [ { "name": "frames", "status": "PASS", "detail": "1830 (expected 1830)" } ],
  "summary": { "pass": 20, "warn": 0, "advisory": 0, "fail": 0 }
}
```

`qa/qa-audio.json`：`detectedBpm / beatOffset / gridHitRate / gridHitRateCount / peakDbtp / integratedLufs / hf / cues[] / checks[] / summary`。

## 4. CI smoke

`.github/workflows/compiler.yml` 的 `static` job 跑纯 Node 全量套件（`test-all.mjs --json`）、
错误码注册表 `--check`、字体锁一致性、spec/plan 门禁、CLI 冒烟与 shell 语法；
`test-browser-nightly.yml`（nightly + 手动触发）跑浏览器套件——frames 逐像素、server/test-api
真实编译等以前只能人肉的门禁。
全片 41 s 走 `npm run fixture:e2e`（含 `--platform douyin --strict`）手动验证。

## 5. 常见失败

| 失败 | 原因 | 修复 |
|---|---|---|
| 帧数少 1–2 | 最后一段 `duration` 不是 `frames/fps` | 用 plan 的 `duration`，不要手写 |
| 黑帧告警 | 风格段本身是黑底 | 检查是否超过 1% 总时长；必要时把该段加入白名单 |
| 冻结告警 | 静态大字卡 | plan 已白名单 `card/flash/more`；自定义静态段需改 `staticWindows` |
| 响度不够 | 合成时没归一化 | 用 `concat-and-encode.sh` 的 loudnorm；量测失败现在会拦（strict exit 12） |
| GOP 告警 | 某条编码路径没接 keyint | 全链路已统一 keyint=2×fps（含无音轨平台重排） |
| VMAF 低 | 参考片是平台压缩版 | 换 CRF12 中间片做参考 |
| cue 对齐低 | 音频与剪辑表不是同一组时间常数 | 让 `synth_audio.py` 直接读 `plan.json` 的 cues |
| E_PLAN_MISSING / E_PLAN_INCOMPLETE | --plan 缺失或残缺 | 先 `cvs plan` 生成完整 plan |