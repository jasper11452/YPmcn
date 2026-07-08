# YPmcn OpenClaw Plugin

面向 OpenClaw 的"媒介助手"插件。Agent 只负责阶段路由、MCP 调用、人工 gate 和短回复；需求解析、筛选、排序、写入、版本校验与数据库事实查询全部由独立接入的 MCP 实现。

## 包结构

```text
YPmcn/
├── openclaw.plugin.json      # 插件 manifest
├── package.json              # npm 包元信息
├── tsconfig.json             # TypeScript 编译配置
├── src/
│   └── index.ts              # 运行时入口：注册 before_tool_call / after_tool_call / tool_result_persist hooks
└── skills/media-assistant/
    ├── SKILL.md
    └── references/
        ├── requirement-intake.md
        ├── requirement-parsing.md
        ├── mcp-tool-routing.md
        ├── workflow-state-machine.md
        ├── frontend-response.md
        ├── hook-behavior.md
        └── validation-playbook.md
```

运行时通过 `src/index.ts` 注册 OpenClaw Plugin SDK hooks：`validate_requirement` 按生产 `inputSchema` 拦截非法请求字段；可选状态扩展存在时再执行状态/风险防护；MCP 基础信封破损时由 `tool_result_persist` 改写为 `INVALID_RESPONSE_CONTRACT`。

## 安装

```bash
cd YPmcn/
npm install
npm run pack:yp
```

命令会先构建，再在上级目录生成 `ypmcn-media-assistant-2.0.9.tgz`。安装时选择这个 tgz 包，不要直接填写源码目录。在 OpenCode/YP Action 中安装插件后，还需在 `opencode.json` 配置 SSE MCP Server：

```json
"mcp": {
  "ypmcn": {
    "type": "remote",
    "url": "https://mcp.eshypdata.com/sse",
    "enabled": true
  }
}
```

`create_with_distributions` 工具由 MCP Server 提供，无需 `tools.alsoAllow`。

## Hooks 说明

本插件通过 OpenClaw Plugin SDK 注册运行时钩子，独立于模型自觉提供硬约束：

### YP Action 通知能力

当前插件将 `create_with_distributions` 注册为钩子拦截工具，真正的工具实现由 SSE MCP Server 提供：`https://mcp.eshypdata.com/sse`。插件自身不持有 API Key、不作 HTTP 调用；只负责 hooks 拦截、参数校验和状态管理。

| Hook | 匹配 | 行为 |
|---|---|---|
| `before_tool_call` | `validate_requirement` | 只允许 `raw_messages`、`project_context`、`existing_demand_id`、`existing_demand_version`，并校验基础类型 |
| `before_tool_call` | 风险 gate | 使用 `medium_risk_confirmed` / `allow_need_confirm_with_risk`，不要求 schema 外字段 |
| `before_tool_call` | `rank_creators` | 未完成 `create_with_distributions` 先阻断；完成后由 `askuserquestion` 确认决定是否继续 |
| `before_tool_call` | `create_with_distributions` | 校验 `deadline/remindAt`，优先固定 `usageScope: "project"`，`项目` 会被 hook 兼容归一，Bash/PowerShell/curl 直连阻断；`askuserquestion` 确认后通过 SSE MCP 发送 |
| `before_tool_call` | 可选状态扩展存在 | 校验 `allowed_actions`、平台前置条件和高风险状态 |
| `after_tool_call` | 所有 YPmcn 结果 | 校验基础响应契约并缓存可选状态扩展 |
| `after_tool_call` | 项目分发成功 | 记录企微询价已发送并进入等待锁；当前不创建 Cron 任务 |
| `tool_result_persist` | 所有 YPmcn 结果 | 基础 `{success,data,error,trace_id}` 信封破损时改写为 `INVALID_RESPONSE_CONTRACT` |
| `message_received` | 同一会话用户新消息 | 解除项目分发等待锁 |

主流程为 `validate_requirement → search_creators → rank_mcns → create_with_distributions → rank_creators`。Brief 输入后直接调用 `validate_requirement` 解析验证；结构化 brief、发送、风险等需要媒介确认的节点统一用 `askuserquestion` 弹窗。`rank_mcns` 后必须停下来展示比例、MCN 机构和企微消息并询问是否发送；企微发送成功且用户再次确认后才允许精排。项目分发与通知在用户确认前不得执行。当前不创建 Cron 任务；发送失败不进入等待锁，发送成功后收到用户新消息前不得执行下一步。

## MCP 接入

MCP 在 OpenClaw 中独立配置。当前生产 provider 暴露以下 9 个写工具 + 2 个只读查询（共 11 个 YPmcn 工具）：

```text
validate_requirement
search_creators
rank_mcns
manual_source_creators
ingest_mcn_submissions
rank_creators
create_submission_batch
record_client_feedback
audit_manual_adjustment
get_creator_detail
get_recommendation_run_detail
```

当前生产没有 `get_workflow_state`。企微分发统一使用 `create_with_distributions`；旧 `create_mcn_inquiries` 已弃用，不作为 Agent 工具或当前链路服务名。运行时 schema 是参数语法权威；缺失或冲突时返回 `integration_required`，不做模型降级。

## 运行边界

- 任意 Brief/CSV 入口先读取运行时 schema；预检通过后直接调用 `validate_requirement`，不先向媒介确认拟传参数。
- 同一流程固定一个 provider，不跨服务混用 ID。
- `validate_requirement` 当前请求不包含 `trace_id`、`idempotency_key` 或 `parsed_requirement`；不得发送 schema 外字段。
- 基础响应必须返回 `{success,data,error,trace_id}`；`workflow_state` 与 `allowed_actions` 是可选扩展。
- 写结果未知时当前没有幂等键，不得盲目重试；有 `run_id` 时用详情查询核对，否则按 `trace_id` 交后端排查。
- `record_client_feedback.data.next_action` 是唯一客户反馈路由。
- 前端只给短结论，不泄露完整 JSON、状态快照、算法或数据库结构。

详见 [主 Skill](skills/media-assistant/SKILL.md) 及其 5 份 reference。

## 格式说明

本插件从 WorkBuddy 格式迁移至 OpenClaw 原生格式：

- `.workbuddy-plugin/plugin.json` → `openclaw.plugin.json`（OpenClaw 原生 manifest）
- 声明式 `hooks.json` → `src/index.ts` 运行时 hooks：`before_tool_call`、`after_tool_call`、`tool_result_persist`
- Skill 格式保留（`SKILL.md` + `references/`），用于 Agent 指令和业务语义说明
