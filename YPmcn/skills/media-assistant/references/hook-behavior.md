# Hook 行为

Runtime hooks 在 `dist/index.js`，包含 `before_tool_call`、`after_tool_call`、`tool_result_persist`、`message_received`。Agent 不需要主动处理这些（hook 会静默阻断/修正）。

## 阻断点

- **字段检查**：`validate_requirement` 传入的 CSV 必填字段有值时的类型校验（hook 只做类型检查，不做语义校验）
- **链式业务 ID**：`search_creators`/`rank_mcns`/`rank_creators` 等下游工具必须先有上一步成功响应里的非空 `id`（映射旧业务表主键，不代表新表名）；`demand_id`/`demand_version` 如同时存在不因它们单独阻断
- **状态守护**：`workflow_state.allowed_actions` 有值时遵守白名单
- **风险熔断**：`risk_level=high_risk` 未通过 `supply_recovery` 前阻 `rank_creators` / `create_submission_batch`
- **Gate 拦截**：`pending_gate` 存在时阻非确认调用
- **分发门控**：`deadline` / `remindAt` 必须是带时区未来时间；`supplierIds` 必须非空字符串数组；`usageScope` 缺失补 `project`，传错阻断；有角色上下文时仅允许 `media/procurement`
- **禁止直连**：Bash/PowerShell/curl 访问 `/api/projects/create-with-distributions/` 会被阻断；只能用 MCP 工具 `create_with_distributions`
- **前置校验**：`rank_creators` 前必须有 `create_with_distributions` 成功（project_distribution_completed）
- **供给回收校验**：企微发送后，`rank_creators` 仍需看到机构回填/手扒已回收到候选池，或 `ranking_after_supply_ready_confirmed` 等会话确认
- **结果持久化**：不因缺少 `trace_id`、响应信封细节或启发式语义疑似问题改写结果；MVP 阶段优先跑通流程

## Hook 分层

- `before_tool_call`：校验 `validate_requirement` 请求的基础类型和 `platform` 枚举、`allowed_actions`、`workflow_state.pending_gate`、角色、链式 ID、分发前置和精排前置。不替代 MCP 业务校验，不因 schema 外字段（`trace_id`、`parsed_requirement` 等）阻断。
- `after_tool_call`：缓存可选 `workflow_state`，记录分发成功与已访问步骤；`create_with_distributions` 正式发送成功后设置等待锁（`preview_only: true` 不设锁）。
- `tool_result_persist`：保留原始 envelope；不因缺少 `workflow_state` 或 `allowed_actions` 本身报错，也不再返回 `INVALID_RESPONSE_CONTRACT` 阻断。

MVP 阶段不强制 `gate_id`、`confirmation_type`、`operator_id`、`trace_id` 等细项作为阻断条件；风险确认仍使用真实 schema 字段 `medium_risk_confirmed` 和 `allow_need_confirm_with_risk`。

`create_with_distributions` 不再触发 OpenClaw `requireApproval`，用户确认前不得创建分发或发送通知。

## 等待锁

`create_with_distributions` 正式发送成功（`preview_only !== true`）后，hook 设置等待锁。等待锁期间：
- 除 `askuserquestion` 外的工具调用都被阻断。
- Agent 必须停在等待机构回填/手扒结果阶段。
- `message_received` 事件清除等待锁；清锁不等于可以直接精排，仍要有回填/手扒结果已回收到候选池的业务证据。
- 调用失败不进入等待锁；当前不创建 Cron 任务。

## Agent 需配合的点

- `create_with_distributions` 成功发送后 hook 会设置等待锁。Agent 需停在等待机构回填/手扒结果；只有回填和手扒结果回收到候选池后，才用 `askuserquestion` 弹窗 `confirm-ranking-after-supply-ready` 让用户确认对候选池进行达人精排
- 需要手扒时，在 MCN 列表确认后同步启动手扒程序（`manual_source_creators`），不等 MCN 回填结束
- 调用失败不进入等待锁。
- 等待锁用于提醒 Agent 停在供给回收阶段；精排工具会被前置条件阻断
- `message_received` 事件会清除等待锁；清锁不等于可以直接精排，仍要有回填/手扒结果已回收到候选池的业务证据
