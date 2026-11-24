# app/frames — 逐帧实时预览工作台

一个零依赖的本地工作台：**按帧号**预览「正在制作的图 / 视频」，不是按秒近似。

```bash
node app/frames/serve.mjs                        # http://127.0.0.1:5186/app/frames/
node app/frames/serve.mjs --plan out/plan.json   # 直接打开一个 plan
node app/frames/serve.mjs --video out/master.mp4  # 直接看成片每一帧
node app/frames/serve.mjs --dir out/images       # 图片序列翻页
# 或
npx cvs frames --spec project.spec.json
```

命令行给了帧源会预先 open 并在终端打印带 `?id=` 的 URL；不给也能在页内从「最近产物」里选。

## 三种帧源

| 源 | 参数 | 取帧方式 | 说明 |
|---|---|---|---|
| spec / plan | `--plan` / `--spec` | 模板页在**同源 iframe** 里直接 `renderFrame(n 段内帧号 / fps)` | 不读回像素，实测 0.3–0.8 ms/帧（p95 0.5 ms）；与 `render-segment.mjs` 同页面 URL / 同 `t` |
| video | `--video` | ffmpeg `-fps_mode passthrough` 逐帧解码成 JPEG，按帧号读 | 边解码边可看（`ready` 递增）；首次打开建缓存 |
| images | `--dir` | 目录图片 / `image-manifest.json` 一张一帧 | 文件名自然排序 |

### spec 源为什么是 iframe

渲染管线本来就是「代码逐帧画 → Chrome → 截图 → ffmpeg」。工作台里如果每帧都
`toDataURL` 再传到浏览器，在软件渲染下 **编码单帧要 130–300 ms**（1920×1080 更高），
拖动不可能实时。iframe 直接显示同一张 canvas，只调 `renderFrame()`（实测 <1 ms），
所以是真正逐帧实时的；`iframe` 池最多 6 个，按队列**串行**预加载后面 3 段
（并发加载反而互相拖慢），静态资源 2 分钟缓存、HTML 仍 no-store。

> 像素证据：`scripts/test-frames.mjs` 会把 live 画布与服务端按帧号渲染的 PNG
> 逐像素比对，要求 **meanDiff = 0**（段首 / 段内 +1 / 跨段三个位置）。

## 帧号约定

与 `templates/render-segment.mjs` **完全一致**：

```
frames = round(duration * fps)
段内第 i 帧 → 段内时间 t = i / fps
全片第 n 帧 → 所在段 seg，i = n - seg.startFrame，t = i / fps
时间码 = HH:MM:SS:FF（FF = 秒内帧序号）
```

`?seg=1&t0=&speed=&dur=` 的拼法与 `withSegmentParams()` 相同，所以预览帧就是
成片里编码前的那一帧。

## 界面

- **传输条**：上一帧 / 下一帧（±1）、±10、首/末帧、播放/暂停、循环、0.25×–2×、帧号滑杆与输入
- **实时读数**：实测 fps、目标 fps、单帧渲染耗时（live）/ 到达延迟（img）、失败数
- **段落条**：每段一块，颜色区分类别，点击跳到段首
- **胶片条**：video/images 是真缩略图；spec 用帧号卡（避免服务端再起 Chrome 抢 CPU）
- **快捷键**：`←/→` ±1，`Shift+←/→` ±10，`Home/End`，`Space`，`I/O` 设循环入出点，`L` 循环区间，`D` 下载当前帧，`F` 全屏
- **下载本帧**：spec 直接取 iframe canvas 的原始像素（PNG，原生分辨率）；video/images 走服务端

## HTTP API

服务默认只绑 `127.0.0.1`；静态资源仍以仓库根为根（与 `app/canvas`、`app/review` 一致）。

```
GET /frames/api/health
GET /frames/api/candidates                            out/ 下最近的视频 / plan / spec / 图片目录
GET /frames/api/open?video=|plan=|spec=|dir=…[&fps=]  打开帧源 → { id, meta }
GET /frames/api/meta?id=                             状态（视频解码进度在 decoded/done）
GET /frames/api/frame?id=&n=&fmt=jpeg|png&q=         第 n 帧图片字节
GET /frames/api/close?id=
```

响应头带 `X-Frame-Index`、`X-Frame-Time`、`X-Frame-Timecode`、`X-Frame-Segment`、
`X-Frames-Ready`、`X-Render-Ms`，方便脚本核对。

安全边界：所有路径必须落在项目根内，拒绝 `..` 与点目录；`id` 必须是服务端签发的
`f-<n>`；只接受 GET/HEAD。

## 限制与已知边界

- **没有声音**：只看画面。成片音轨请用 `cvs qa` / 播放器。
- **spec 切段有首帧延迟**：每段是一个独立页面（URL 参数 baked-in），首次载入要等
  `__ready`（字体，冷启动 0.3–3 s；mini 41s 这类 1920×1080 重页面首段可到 10 s+）。
  载入期间播放时钟冻结（不会跳帧或 HUD 跑到画面前面）；已载入的段跳转 0–6 ms。
- **spec 预览分辨率 = spec 原生分辨率**（iframe 视口即设计尺寸，CSS 缩放显示）。
  不能把 1920×1080 的页面缩到 640×360 渲染——页面字号是固定 px，布局会变，
  就不再是成片那一帧。
- **视频源**首次打开要把整片解码到 `out/frames-cache/`（可 `--refresh` 重建；
  缓存键含文件 mtime/大小/预览宽度/JPEG 质量）。预览默认最长边 1280，`--max-width` 可调。
- **图片源**按目录读取；`image-manifest.json` 存在时按清单顺序，否则自然排序。
- **无鉴权**：仅本机回环。不要把端口暴露到局域网。
- **帧 API 的 spec 模式**按需渲染并缓存最近 240 帧；每次渲染在软件渲染下约
  0.1–1 s（分辨率相关），适合取单帧/做缩略图，不适合当视频流。

## 文件

| 文件 | 作用 |
|---|---|
| `source.mjs` | 三种帧源 + 纯帧号数学（可在 Node 里单测） |
| `serve.mjs` | 静态服务 + `/frames/api/*` + CLI |
| `app.js` | 工作台宿主（iframe 池 / 图片缓存 / 播放节奏 / 键盘） |
| `index.html` / `style.css` | 界面 |
| `scripts/test-frames.mjs` | 73 条验收（数学 / API / 安全 / 像素一致 / UI） |

## 测试

```bash
node scripts/test-frames.mjs              # 全量（需要 ffmpeg + Chrome）
node scripts/test-frames.mjs --no-browser # 纯函数 + 视频/图片 API
```
