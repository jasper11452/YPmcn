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

运行时通过 `src/index.ts` 注册 OpenClaw Plugin SDK hooks：`validate_requirement` 按生产 `inputSchema` 做基础类型检查；可选状态扩展存在时再执行状态/风险防护；`tool_result_persist` 不因 `trace_id` 或响应信封细节改写结果，避免阻断 MVP 主流程。

## 安装

```bash
cd YPmcn/
npm install
npm run pack:yp
```

命令会先构建，再在上级目录生成 `ypmcn-media-assistant-2.1.3.tgz`。安装时选择这个 tgz 包，不要直接填写源码目录。在 OpenCode/YP Action 中安装插件后，还需在 `opencode.json` 配置 SSE MCP Server：

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
| `before_tool_call` | `validate_requirement` | 校验媒介/Agent 可传解析字段的基础类型；`id`、`demand_id`、`demand_version`、状态和时间字段由 MCP/DB 生成，不作入参必填 |
| `before_tool_call` | 风险 gate | 使用 `medium_risk_confirmed` / `allow_need_confirm_with_risk`，不要求 schema 外字段 |
| `before_tool_call` | `rank_creators` | 未完成 `create_with_distributions` 先阻断；完成后仍需确认机构回填和手扒结果已回收到候选池，再由 `askuserquestion` 确认是否精排 |
| `before_tool_call` | `create_with_distributions` | 校验 `id`（来自 `rank_mcns.data.id`）、`deadline/remindAt`、`supplierIds`，优先固定 `usageScope: "project"`，`项目` 会被 hook 兼容归一，Bash/PowerShell/curl 直连阻断；`askuserquestion` 确认后通过 SSE MCP 发送 |
| `before_tool_call` | 可选状态扩展存在 | 校验 `allowed_actions`、平台前置条件和高风险状态 |
| `after_tool_call` | 所有 YPmcn 结果 | 缓存可选状态扩展；不因响应信封细节阻断流程 |
| `after_tool_call` | 项目分发成功 | 记录企微询价已发送并进入等待锁；当前不创建 Cron 任务 |
| `tool_result_persist` | 所有 YPmcn 结果 | 不改写工具结果，仅保留状态缓存能力 |
| `message_received` | 同一会话用户新消息 | 解除项目分发等待锁 |

主流程为 `validate_requirement → search_creators → rank_mcns → create_with_distributions → ingest_mcn_submissions/manual_source_creators → rank_creators`。Brief 输入后直接调用 `validate_requirement` 解析验证；必填项为 `platform/submission_deadline_at/raw_messages_json/budget_min_cents/budget_max_cents/budget_raw/rebate_min_rate/rebate_raw/quantity_total`，预算/单价必须区间化，返点仅下限必填（上限可选，未填时视为无上限）。`rank_mcns` 后必须停下来展示供需关系、建议手扒比例、建议询价 MCN 列表和企微消息并询问是否发送；企微发送接口字段固定，每个 MCN 有唯一填报链接，并按 MCN 预填候选池中属于该机构的达人。项目分发与通知在用户确认前不得执行。当前不创建 Cron 任务；发送失败不进入等待锁，发送成功后等待机构回填和手扒结果回收到候选池，不能直接精排。

下游 ID 传递统一使用上一步 MCP 成功响应的 `data.id`：`validate_requirement.data.id → search_creators({id}) → search_creators.data.id → rank_mcns({id}) → rank_mcns.data.id → create_with_distributions({id, ...})`。`demand_id`、`demand_version` 只作内部版本字段，不作为下游工具参数。

## MCP 接入

MCP 在 OpenClaw 中独立配置。当前生产 provider 暴露以下 10 个写工具 + 2 个只读查询（共 12 个 YPmcn 工具）：

```text
validate_requirement
search_creators
rank_mcns
create_with_distributions
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
- `validate_requirement` 当前请求不强制 `trace_id`、`idempotency_key` 或 `parsed_requirement`；按运行时 schema 传参。
- 基础响应尽量返回 `{success,data,error,trace_id}`；`workflow_state` 与 `allowed_actions` 是可选扩展。hook 不因 `trace_id` 或信封细项缺失阻断。
- 写结果未知时当前没有幂等键，不得盲目重试；有 `run_id` 时用详情查询核对，否则按 `trace_id` 交后端排查。
- `record_client_feedback.data.next_action` 是唯一客户反馈路由。
- 前端只给短结论，不泄露完整 JSON、状态快照、算法或数据库结构。

详见 [主 Skill](skills/media-assistant/SKILL.md) 及其 5 份 reference。

## 格式说明

本插件从 WorkBuddy 格式迁移至 OpenClaw 原生格式：

- `.workbuddy-plugin/plugin.json` → `openclaw.plugin.json`（OpenClaw 原生 manifest）
- 声明式 `hooks.json` → `src/index.ts` 运行时 hooks：`before_tool_call`、`after_tool_call`、`tool_result_persist`
- Skill 格式保留（`SKILL.md` + `references/`），用于 Agent 指令和业务语义说明
