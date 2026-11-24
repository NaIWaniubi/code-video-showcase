# Reproducibility：容器 / 编码 / 像素三层归因

> G9。`scripts/attest.mjs` 的原理文档；操作入口是 `cvs attest --help`。
> 与 `scripts/determinism-check.mjs` 的关系：那边是**产线自检探针**（同一台机连渲两次
> 比字节），这边是**交付证据封存**（证书可拿到另一台机、由不相干的人离线复核）。
> 两者共享同一套分层思想：整只 mp4 的 sha256 把「容器 / 编码 / 像素」三层混为一谈，
> 红的时候无法归因——所以必须拆开。

## 1. 三层各是什么，何时会独立变化

| 层 | 证据 | 会因何改变 | 不会因何改变 |
|---|---|---|---|
| 容器 | mp4 文件本体 sha256 + 字节数 | 任何一字节变化；mux 时间戳、写盘顺序、`creation_time` 元数据 | —（它最敏感，也最没有解释力） |
| 编码流 | 未单独封存（由容器层吸收） | 重编码、换 CRF/preset | remux（不重编码时码流不变，但容器仍可能变） |
| 像素 | `ffmpeg -f framemd5` 的逐帧 md5 序列 | 渲染像素有任何一个 bit 变化（字体、浏览器版本、CSS 抖动、素材换字节） | remux、时间戳、muxer 头、容器元数据 |

关键判读规则（与 `determinism-check --video` 的 verdict 同口径）：

- **像素层同、容器层异** → mux 抖动。像素可复现成立，文件完整性不成立。`pass-with-note`。
- **像素层异**（md5 序列不同或帧数不同）→ 真漂移。这是「same input same video」承诺被
  打破的唯一硬证据。`FAIL`（exit 13，`E_ATTEST_DRIFT`），并给出首个漂移帧号。
- **toolchain 异、像素层同** → 跨机常态，信息不是失败。诚实边界：不同 ffmpeg 版本的
  码流字节本就不同，容器层几乎必红；能不能交付取决于你承诺到哪一层——像素级承诺看
  framemd5，字节级承诺还得工具链一致。证书把两层分开呈现，归因留给读证书的人。
- **plan 层异** → 段哈希/时间轴与产物对不上：这份 mp4 不是（或不只是）这份 manifest
  渲出来的。绑定断裂，FAIL。

## 2. 为什么 framemd5 只取 md5 列

`ffmpeg -f framemd5 -` 每行是
`stream_index, dts, dts_time, duration, duration_time, size, md5`。
`determinism-check` 聚合整段 stdout（同机双跑够用）；attestation 面向**跨机**比对，
把 dts/size 列一律丢弃、只保留 md5 列：

- `md5` 是对**解码后原始帧数据**的内容寻址——它就是「这一帧长什么样」的指纹；
- dts/size 与容器和封装参数耦合，留着它们会把 mux 抖动误报成像素漂移。

聚合 digest = sha256(md5 列逐行拼接)。同时把逐帧 md5 数组（`layers.frames.perFrame`）
留在证书里：复核 FAIL 时能指认到「第几帧开始漂」，而不只是「摘要不等」。

## 3. digest 为什么可以跨机重算

`digest = sha256(canonicalJson(layers))`：

- `canonicalJson` 递归键排序、数组顺序保留（段列表的数组序 = plan 时间轴序，
  这是 R2-17 对 render-manifest 键序纪律的延伸——顺序本身是语义，不能被排序抹掉）；
- 被哈希核心里没有生成时间、没有绝对路径、没有文件大小之外的文件系统元数据；
- 归属信息（`generatedAt`、源文件路径、cvs 版本）单独放 `meta` 段，**不在 digest
  覆盖范围内**。跨机重放时 `meta` 必然不同，`digest` 应当相等——这是设计目标，
  `test-attest.mjs` 用「改 meta 不改 digest、verify 仍绿」锁住这条性质。

verify 不做「摘要对摘要」的一刀切，而是逐层重算比对；另加一道**证书自摘要校验**
（`digest` 是否等于对 `layers` 重算的 canonical digest）——只改 `layers` 里某个字段
的篡改会被当场指认（`selfDigestOk: false`，FAIL）。

## 4. 边界与诚实声明

- 证书证明的是「这份 mp4 与这份 manifest/plan 在这套工具链下产出、且另一台机重放的
  解码帧一致」；它不证明 spec 的创意正确性，也不证明渲染器永不带病——那些归
  `cvs qa` / `cvs taste`。
- `toolchainFingerprint` 的 ffmpeg/浏览器版本取自产证书当时；若产片与产证书跨了进程
  环境，指纹会如实记录产证书侧（与 plan.meta.toolchain 同源可比）。
- 音频不在本证书范围（G9 定义的四层里没有音轨层）；成片音频完整性目前由
  `delivery.json` 的 sha256 承担。
- 帧层比对假设 h264 解码跨机确定性（同 ffmpeg 主版本族内成立；这正是 toolchain 层
  要如实呈现的原因——若两台机解码器差异大到影响像素，帧层会红，而非被掩盖）。

## 5. CI / 机器可读用法

```bash
cvs attest out/master.mp4 --out deliver/master.attestation.json --json
# …交付、归档、换机…
cvs attest replay/master.mp4 --verify deliver/master.attestation.json --json
# stdout 即结构化 verdict：{verdict: pass|pass-with-note|fail, layers:{container,
# frames,toolchain,plan}, notes, selfDigestOk, exitCode}
# 退出码：0=pass/pass-with-note · 2=输入问题 · 13=判红 · 14=ffmpeg 取证失败
```

MCP 侧对应工具：`cvs_attest`（`mcp/server.mjs`，参数 videoPath/verifyPath/
manifestPath/planPath/outPath）。
