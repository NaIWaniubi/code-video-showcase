# app/ui — 统一工作台（一个端口六个界面）

```bash
cvs ui                 # http://127.0.0.1:5180/app/
node app/ui/serve.mjs --port 5180
```

`/app/` 是首页：六张卡片分别进入向导、剧本表格、画布、版本树、评审、帧预览，
并给出每步的命令。每个界面顶栏都有「← 工作台」。

## 路由

| 路径 | 去处 |
|---|---|
| `/app/` | 首页（`app/index.html`） |
| `/app/wizard/`、`/app/canvas/`、`/app/script/`、`/app/versions/`、`/app/review/`、`/app/frames/` | 六个界面 |
| `/frames/api/*` | 帧 API（`app/frames/serve.mjs` 的 listener） |
| `/jobs`、`/jobs/*`、`/health` | 反代到 `REVIEW_API`（默认 `http://127.0.0.1:5190`，即 `cvs api`） |
| 其他 | 仓库根静态文件 |

## 为什么不直接用某一个 surface

六个界面原本各起一个端口，没有统一入口，帧 API 与评审反代也不在同一个 origin。
`cvs ui` 把它们挂到同一个 server 上：首页可导航、帧预览开箱即用、评审页无需
`?api=`。单独 `cvs canvas` / `cvs frames` / `cvs review` 仍然可用，行为不变。

## 边界

- 只绑 `127.0.0.1`，无鉴权；不要暴露到局域网。
- 评审依赖 5190 的 API；API 没起时 `/jobs/*` 返回 502，页面显示「API unreachable」。
- 静态缓存：HTML `no-store`；`/templates`、`/node_modules`、`/assets` 2 分钟，
  字体 10 分钟（给帧预览的 iframe 池复用）。改模板后强刷即可。
- 帧预览的 spec 模式按原生分辨率渲染，切段首次载入需要等页面 `__ready`。
