# Hook 行为

Runtime hooks 在 `dist/index.js`，会拦截以下情况。Agent 不需要主动处理这些（hook 会静默阻断/修正）。

## 阻断点

- **字段检查**：`validate_requirement` 传入的 CSV 必填字段有值时的类型校验（hook 只做类型检查，不做语义校验）
- **状态守护**：`workflow_state.allowed_actions` 有值时遵守白名单
- **风险熔断**：`risk_level=high_risk` 未通过 `supply_recovery` 前阻 `rank_creators` / `create_submission_batch`
- **Gate 拦截**：`pending_gate` 存在时阻非确认调用
- **角色校验**：`create_with_distributions` 仅媒介/采购可调
- **前置校验**：`rank_creators` 前必须有 `create_with_distributions` 成功（project_distribution_completed）
- **响应契约**：缺少 `trace_id` / 字段矛盾 → 自动改写为 `INVALID_RESPONSE_CONTRACT` / `INVALID_REQUIREMENT_PARSE`，通知 Agent

## Agent 需配合的点

- `create_with_distributions` 成功后 hook 会设置等待锁，Agent 需用 `askuserquestion` 弹窗 `proceed-to-ranking` 让用户决定是否精排
- 等待锁期间除 `askuserquestion` 外不允许其他工具调用
- `message_received` 事件会清除等待锁
