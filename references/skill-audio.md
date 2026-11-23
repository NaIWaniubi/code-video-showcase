> 自 SKILL.md §8（配乐合成）拆出，2026-11-24。

## 8. 配乐合成（120 BPM，A 小调，纯 numpy/scipy）

- 可运行骨架 `templates/synth_audio.py`：无参 = 8 s demo；`--plan out/plan.json` = 全片长度，并把每个 `audio.cues` 落成鼓点（61 s 实测 cue 命中 100% ±30 ms）。
- **旁白声道（v3.0）**：`spec.audio.vo = [{text, start, duration}]` → `synth_voice.py` 出语音 + 词级时间戳（piper 在场则优先真实 TTS，否则离线共振峰合成，机械音色仅供排版验证），compile 自动 **sidechain 闪避混音**（说话时音乐让位），QA 响度闭环仍守 −14 LUFS。
- **程序化生成画面（v3.0）**：`templates/generative.mjs` 提供流场群游/轨道环系/脉冲波/弹跳字四族确定性纯核（种子哈希闭式粒子，同 t 同像素），目录式注册可直接被配方页复用——与「No generative models」一致：无扩散模型，全部是 (t, seed) 纯函数。
- 结构：开场铺底 + 逐字键盘咔哒 → 4.55 s sub boom + 底鼓渐强 → 军鼓滚奏 → 反向镲；大字卡 drop-out（音乐压到 6%）；风格段 6 拍律动 + 专属乐器。
- 混音链：kick 侧链（闪避 55%）→ 2.2 s 合成混响 → tanh 软削波 → 母版峰值 −1.5 dBFS（留余量给 loudnorm 与 QA 门限）。
- **高频克制（必读）**：金属音色（FM 钟声/拨弦/亮 stab/coin/高八度琶音）只作关键节点点缀，**全片 2–3 处**；统计与数字段用 sub+tom+kick+clap，不用铃音代替鼓点；切掉 <200 Hz 只剩「叮叮叮」= 过量；8–16 kHz 非点缀段应比点缀段低 ≥6 dB。
- 音色公式、和弦进行表、编排、混音函数与 numpy 检测代码见 `references/audio-recipes.md`。

