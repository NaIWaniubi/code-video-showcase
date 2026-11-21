# CVS MCP 接口（任意 agent 一行接入）

`npm run mcp`（= `node mcp/server.mjs`）启动一个 **MCP stdio 服务**：把 `cvs`
全链路的语义级能力暴露为 12 个工具（含 taste 审美闸），任意支持 MCP 的 agent（Claude Desktop、
Cursor、Claude Code、ZCode…）零端口、零 token、零常驻地直调。

## 接入配置（一行 command，无需网络）

**Claude Desktop**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "code-video-showcase": {
      "command": "node",
      "args": ["E:/path/to/code-video-showcase/mcp/server.mjs"]
    }
  }
}
```

**Cursor**（`.cursor/mcp.json`）、**Claude Code**（`claude mcp add`）、**ZCode**
同理：`command: node`，`args: [<仓库路径>/mcp/server.mjs]`。

## 工具集

| 工具 | 语义 | 安全默认 |
|---|---|---|
| `cvs_new` | 自然语言 → spec（确定性规则，无模型调用） | 不落盘（除非给 outPath） |
| `cvs_suggest` | 结构 → 建议切点（与 HTTP 端点同口径） | 只读瞬时 |
| `cvs_lint` | spec 门禁 lint | 只读 |
| `cvs_plan` | spec → plan 摘要 | 只读 |
| `cvs_build` | lint→plan→渲染→concat→QA 全链 | **默认 dry-run**，显式 apply 才落盘 |
| `cvs_edit` | 结构四件套 split/drop/move/trim（D 公式闭合） | 默认 dry-run；apply 自动 `.bak` |
| `cvs_qa` | 双闸质检（视频+音频） | 只读 |
| `cvs_image` | 出图集（封面/海报/卡片/故事图，艺术静帧） | 写 out/ |
| `cvs_ship` | 交付打包 zip（--check 先过双闸） | 只读校验 |
| `cvs_demo` | 导演演示集一键出片 | 写 out/ |
| `cvs_health` | 一键全身体检 | 只读 |

## agent 使用范式（示例）

```
1) cvs_new   text="做一条 30 秒赛博竖屏国风宣传片" outPath: "project.spec.json"
2) cvs_lint  specPath: "project.spec.json"
3) cvs_build specPath: "project.spec.json"          # dry-run 验证（D 公式闭合、lint 过）
4) cvs_build specPath: "project.spec.json" apply: true, timeoutSeconds: 900   # 真出片
5) cvs_qa     videoPath: "out/<片名>/master.mp4" strict: true
6) cvs_ship   specPath: "project.spec.json" check: true
```

改结构走 `cvs_edit`（splitAt/drop/move/trim），拿不准切点先 `cvs_suggest`。

## 为什么选 MCP 而非再包一层 HTTP

- 既有 `server/api.mjs` 是给网页面的 job 队列（202 + 轮询）；agent 场景下每次
  都是一次性短会话——stdio 天然匹配：起进程 → 调工具 → EOF 退出；
- 零端口暴露面：不监听任何网卡、不需要 token/CORS；
- 官方 SDK 兼容的手写最小协议（newline JSON-RPC 2.0：`initialize` /
  `tools/list` / `tools/call`），无新增依赖。

## 回归

`node scripts/test-mcp-server.mjs` —— 真实子进程 + 真线协议：握手、10 工具
schema、suggest/lint/new 实调、未知工具/方法错误码、EOF 干净退出。