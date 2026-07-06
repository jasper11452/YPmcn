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

命令会先构建，再在上级目录生成 `ypmcn-media-assistant-1.0.5.tgz`。在 YP Action 中打开「设置 → 插件 → 安装插件 → 本地路径」，选择该 `.tgz` 文件。

每次重新打包前必须先更新版本号，并保持 `package.json`、`package-lock.json`、`openclaw.plugin.json` 和 `.claude-plugin/plugin.json` 版本一致；否则新包可能被 YP Action 当成旧版本处理。

不要直接填写源码目录 `YPmcn/`：YP Action 2026.6.1 会用本地来源路径反推插件 ID，而源码目录名与 manifest ID `ypmcn-media-assistant` 不同，会在 OpenClaw 已完成 staging 后误报 `Plugin installed but could not determine plugin ID`。使用上述同名 `.tgz` 是稳定安装方式。插件入口为 `openclaw.plugin.json`。

`create_with_distributions` 是 optional 工具。安装后如果运行时提示「工具未暴露」，说明尚未在 YP Action/OpenClaw 的 `tools.alsoAllow` 中增量允许该工具；这是安全策略，不是 MCP 未启动。正式发送企微询价前需放行 `create_with_distributions`，否则流程会停在询价前，不能继续精排或提报。不要用 `tools.allow` 只写这一项，否则可能把其他工具收窄掉。

## Hooks 说明

本插件通过 OpenClaw Plugin SDK 注册运行时钩子，独立于模型自觉提供硬约束：

### YP Action 通知能力

当前插件不直接调用独立的 YP Action 通知 API。1.0.5 安全版将 `create_with_distributions` 注册为 optional 工具，默认不暴露；需通过 `tools.alsoAllow` 增量放行后才会出现在 Agent 可用工具中。本地工具只返回 dry-run，不接受 Agent 入参控制真实发送地址或执行开关。插件负责审批、阻断 Bash/PowerShell/curl 绕过、校验 `deadline/remindAt`、记录成功状态并等待用户继续。当前不创建 Cron/提醒任务。

| Hook | 匹配 | 行为 |
|---|---|---|
| `before_tool_call` | `validate_requirement` | 只允许 `raw_messages`、`project_context`、`existing_demand_id`、`existing_demand_version`，并校验基础类型 |
| `before_tool_call` | 风险 gate | 使用 `medium_risk_confirmed` / `allow_need_confirm_with_risk`，不要求 schema 外字段 |
| `before_tool_call` | `rank_creators` | 未完成 `create_with_distributions` 先阻断；通过后仍要求 `allow-once` 审批 |
| `before_tool_call` | `create_with_distributions` | 只支持 YP Action 工具形态；Bash/PowerShell/curl 直连会被阻断；校验 `deadline/remindAt`，要求 `allow-once` 审批，等待期间阻断所有工具 |
| `before_tool_call` | 可选状态扩展存在 | 校验 `allowed_actions`、平台前置条件和高风险状态 |
| `after_tool_call` | 所有 YPmcn 结果 | 校验基础响应契约并缓存可选状态扩展 |
| `after_tool_call` | 项目分发成功 | 记录企微询价已发送并进入等待锁；当前不创建 Cron 任务 |
| `tool_result_persist` | 所有 YPmcn 结果 | 基础 `{success,data,error,trace_id}` 信封破损时改写为 `INVALID_RESPONSE_CONTRACT` |
| `message_received` | 同一会话用户新消息 | 解除项目分发等待锁 |

主流程为 `validate_requirement → search_creators → rank_mcns → create_with_distributions → rank_creators`。前三个业务工具补全需求后连续调用；`rank_mcns` 后必须停下来展示比例、MCN 机构和企微消息并询问是否发送；企微发送成功且用户再次确认后才允许精排。项目分发与通知在用户确认前不得执行。当前不创建 Cron 任务；发送失败不进入等待锁，发送成功后收到用户新消息前不得执行下一步。

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

- 任意 Brief/CSV 入口先读取运行时 schema、向用户确认拟传参数，再调用 `validate_requirement`。
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
