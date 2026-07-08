# Hook 行为

运行时实现位于 `src/index.ts`。Hook 的目标是阻止当前生产 schema 明确不接受的参数，不替代 MCP 业务校验。

## 分层

| Hook | 触发 | 行为 |
|---|---|---|
| `before_tool_call` | `validate_requirement` | 只允许当前四个顶层字段，并校验基础类型 |
| `before_tool_call` | 可选状态扩展存在 | 检查 `allowed_actions`、平台前置条件和高风险状态 |
| `before_tool_call` | 两类风险 gate | 映射到当前 schema 的真实布尔确认字段 |
| `before_tool_call` | `search_creators` | 未完成结构化 brief 确认先阻断 |
| `before_tool_call` | `rank_creators` | 未完成 `create_with_distributions` 先阻断；完成后由用户文本确认决定是否继续 |
| `before_tool_call` | `create_with_distributions` | 校验 `deadline/remindAt`、角色权限（仅媒介/采购）、Bash/PowerShell/curl 直连阻断；确认 gate 列表（比例/名单/表单/权限/发送内容）全部通过后才放行 |
| `after_tool_call` | YPmcn 响应 | 校验基础响应契约，合法时缓存可选状态扩展 |
| `after_tool_call` | `create_with_distributions` 成功 | 记录企微询价已发送并进入等待锁；当前不创建 Cron 任务 |
| `tool_result_persist` | YPmcn 响应 | 破损基础信封改写为 `INVALID_RESPONSE_CONTRACT`；明显违背原 Brief 的需求解析改写为 `INVALID_REQUIREMENT_PARSE` |
| `message_received` | 同一会话的新用户消息 | 解除项目分发等待锁 |

## requireApproval 覆盖清单

当前插件不再为 `create_with_distributions` 或 `rank_creators` 返回 `requireApproval`。这两个入口只依赖 Agent 层文本表格确认；确认后 hook 只做参数、状态和直连绕过校验。

仍可能返回 `requireApproval` 的入口只有没有对应业务字段的 pending gate；生产 schema 已有真实布尔字段的风险确认继续走工具参数。

## `validate_requirement` 请求

允许的顶层字段只有：

- `raw_messages`
- `project_context`
- `existing_demand_id`
- `existing_demand_version`

Hook 会阻断 `trace_id`、`idempotency_key`、`parsed_requirement`、`parsed_requirement_draft` 和其他未声明字段，并一次性列出所有非法键。

基础类型：

- `raw_messages` 必须为数组，每个元素必须为对象。
- `project_context` 必须为对象或 null。
- `existing_demand_id` 必须为字符串或 null。
- `existing_demand_version` 必须为整数或 null。

具体消息内容和业务完整性由 MCP 校验，hook 不在 MCP 前重复实现业务规则。

## 风险确认

当前生产 schema 没有结构化 gate 对象：

- `confirm_medium_risk`：只有 `rank_mcns.medium_risk_confirmed === true` 才可继续。
- `confirm_risky_submission`：只有 `create_submission_batch.allow_need_confirm_with_risk === true` 才可继续。

这两个值必须来自用户本轮明确确认。对于没有对应业务字段的其他人工 gate，hook 不要求 Agent 虚构 `gate_id`、`confirmation_type` 或 `operator_id`；当前链路优先停下报告 `integration_required`。

## 候选池精排确认

- `rank_creators` 前必须先有 `create_with_distributions` 成功发送企微询价的会话证据。
- 若企微询价未发送成功，hook 直接阻断 `rank_creators`，提示先调用 `create_with_distributions`。
- `rank_creators` 前还必须通过状态/风险检查；如果检查失败直接阻断。
- 检查通过后不返回 YP Action `requireApproval`；用户文本确认即为继续精排的唯一交互。
- 未获得用户确认时不得调用 `rank_creators`。

## 项目分发确认与等待

- 只允许 YP Action 工具 `create_with_distributions` 执行分发；旧名 `create-with-distributions` 直接阻断并提示改名。
- `exec`、`bash`、`shell`、`powershell`、`pwsh` 中的 `create_with_distributions` 脚本或 `/api/projects/create-with-distributions/` 直连会被明确阻断；普通文本提及不触发。
- 工具参数必须包含未来的带时区 ISO 8601 `deadline`、`remindAt`、`remind_at` 或嵌套 `project.deadline`。
- `usageScope: "project"` 是唯一固定值；漏传时 hook 会补到顶层或 `project` 对象内，显式传入非 `project` 的 `usageScope` / `usage_scope` / `usageModule` / `module` 会阻断。
- 除上述时间和 `usageScope` 外，hook 不重复实现项目字段 schema；`columns`、`templateId`、`platform`、`supplierIds` 等字段以运行时 `inputSchema` 和后端校验为准。
- 无效时间在创建分发前阻断；Cron 服务不可用不阻断发送。
- 用户确认前不得创建分发或发送通知；用户文本确认后直接执行，不再触发 OpenClaw `requireApproval`。
- 调用成功后，只记录该会话已完成企微询价，并立即进入等待锁；当前不创建 Cron/`agentTurn` 提醒任务。
- 发送模式固定为由 SSE MCP Server (`https://mcp.eshypdata.com/sse`) 处理。
- 调用失败不进入等待锁；同一 `toolCallId` 不重复处理。
- 收到同一会话的用户新消息前，所有工具调用均被阻断。

## 企微角色权限

`create_with_distributions` 调用前 Hook 必须执行角色校验：

- 仅 `media`（媒介）和 `procurement`（采购）角色可继续。
- `account`、`planner`、`com` 等角色直接阻断，提示无企微发送权限。
- 角色信息来自会话上下文 `operatorRole` 或 `sessionState.operator_role`。
- 后端必须额外做二次鉴权、operator_id 和 toolCallId 审计留痕；前端 gate 不能替代后端鉴权。

## 发送前 gate 状态

如果会话上下文 `sessionState.ypmcn_gate_state` 可用，Hook 在 `create_with_distributions` 前校验以下全部为 `true`：

| gate | 含义 |
|---|---|
| `structured_brief_confirmed` | 结构化 brief 已由媒介确认 |
| `supply_ratio_confirmed` | MCN/野生比例已确认 |
| `mcn_list_confirmed` | MCN 机构名单已确认 |
| `form_fields_confirmed` | 回填表单字段已确认 |
| `send_content_confirmed` | 发送内容和对象已确认 |

任一 gate 缺失时阻断并提示确认项。gate 状态由 Agent 层文本确认写入，不可由模型默认填 true。

## 可选状态扩展

当前基础 MCP 响应不要求 `workflow_state` 或 `allowed_actions`。如果 provider 额外返回这些字段，hook 才会使用它们执行状态防护：

- `allowed_actions` 非空时，目标工具必须在列表内。
- `rank_creators`、`create_submission_batch` 前，非 `not_required` 平台必须达到 `ingested`。
- 未完成回填的 `high_risk` 平台不得直接精排或提报。
- `clarify_requirement` 允许再次调用 `validate_requirement`。

状态扩展缺失时不阻断当前生产调用，也不会虚构状态。

## 响应契约

生产基础信封为 `{success, data, error, trace_id}`：

- `trace_id` 必须是非空字符串。
- `success=true` 时 `error` 必须为 null。
- `success=false` 时 `data` 必须为 null，`error` 必须为对象。
- 可选 `workflow_state.pending_gate` 若存在，必须包含 `gate`、`gate_id`、`reason`、`required_fields`。
- 可选 `allowed_actions` 若存在，必须为字符串数组。

基础契约破损时，`tool_result_persist` 改写为：

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "INVALID_RESPONSE_CONTRACT",
    "message": "...",
    "retryable": false
  },
  "trace_id": "..."
}
```

缺少 `workflow_state` 或 `allowed_actions` 本身不是错误。

`validate_requirement` 成功响应会在可取得原始 `raw_messages` 时做最小语义一致性守门：

- 原文 `平台：小红书` 时不得额外返回 `dy`。
- 原文含 `1w粉/1-2w粉` 等粉丝量分层时，不得把粉丝量解析为预算金额。

命中上述明显错抽时，`tool_result_persist` 改写为 `INVALID_REQUIREMENT_PARSE`，阻止 Agent 继续进入搜索/排序。

## 展示边界

通知只给用户可执行的信息：调用成功/失败、业务阶段、风险和下一步。不得展示完整请求、原始 envelope、内部状态、数据库结构或堆栈。只有用户明确排障时提供必要 `trace_id`。
