# 验证手册

本文件用于插件发布前验收。不得用 mock 结果冒充真实 MCP 集成结果。

## 1. Schema 一致性

先执行远端 `tools/list`，验证：

- YPmcn 业务工具共 12 个，且没有 `get_workflow_state`。
- `validate_requirement.required` 至少需要解析字段或 `raw_messages` 之一。
- `validate_requirement.properties` 包含解析字段 + `raw_messages`、`project_context`、`existing_demand_id`、`existing_demand_version`。
- 任一请求 schema 都不强制添加 `trace_id`、`idempotency_key`、`gate_id` 或 `confirmation_type`。
- `rank_mcns` 使用 `medium_risk_confirmed: boolean`。
- `create_submission_batch` 使用 `allow_need_confirm_with_risk: boolean`。

若生产 schema 变化，先更新 hook 测试与 reference，再发布插件。

## 2. Hook 回归

运行：

```bash
npm test
```

至少覆盖：

- 当前 `validate_requirement` 合法请求放行。
- `trace_id`、`idempotency_key` 等 schema 外请求字段不拦截但也不强制。
- 缺少 `raw_messages` 或基础类型错误被阻断。
- 两个风险确认字段为 true 时放行，未确认时阻断。
- `{success,data,error,trace_id}` 合法响应不因缺少状态扩展被改写。
- 缺少 `trace_id` 或成功/失败字段关系错误时改写为 `INVALID_RESPONSE_CONTRACT`。
- 非 YPmcn 工具结果不受影响。

## 3. Skill 行为

用 mock 验证：

1. Brief 入口不等待用户确认；Agent 先读取运行时 schema，预检通过后直接调用 `validate_requirement`。
2. `validate_requirement` 返回 `draft` 时，只按 MCP 返回的缺失必填项和语义模糊点让媒介补充；返回 `ready` 后才用 `askuserquestion` 弹窗确认结构化 brief。
3. 请求体只使用 schema 已声明字段，不用试错调用探测参数。
4. ready/draft/失败分别按前端回复规范呈现，不泄露完整 JSON。
5. 工具缺失或 schema 冲突时返回 `integration_required`。

包外 Python 检查使用：

```bash
uv run python -m unittest discover -s tests -v
```

## 4. 真实 MCP 集成

在隔离测试数据上依次验证主链路，不可逆动作和风险接受前仍须用户通过 `askuserquestion` 明确授权：

- 每个工具只发送当前 schema 字段。
- 响应基础信封具备 `success`、`data`、`error`、`trace_id`。
- `validate_requirement` 成功数据包含 `demand_id`、`demand_version`、`status`。
- 中风险/风险提报分别使用两个真实布尔字段，且只在用户明确确认后设为 true。
- `rank_creators` 返回真实 `run_id`；`create_submission_batch` 复用该 ID。
- `get_recommendation_run_detail` 能按 `run_id` 查询结果。
- 写调用超时后不盲目重试，使用查询能力或 `trace_id` 核对。

## 5. 失败分类

记录为：`INPUT_CONTRACT`、`MISSING_TOOL`、`SCHEMA_CONFLICT`、`INVALID_RESPONSE_CONTRACT`、`BUSINESS_NORMALIZATION`、`STATE_EVIDENCE`、`FRONTEND_LEAK`、`VERSION_CONFLICT`、`INVALID_PHASE`。

参数 schema 问题修插件/hook；业务解析错误修 MCP；不要在 Agent Prompt 中复制解析算法。
