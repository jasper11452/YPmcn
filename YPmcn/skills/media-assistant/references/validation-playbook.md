# 验证手册

本文件用于插件发布前验收。不得用 mock 结果冒充真实 MCP 集成结果。

## 1. Schema 一致性

先执行远端 `tools/list`，验证：

- YPmcn 业务工具共 12 个，且没有 `get_workflow_state`。
- 需求主表固定为 `customer_demands`；`validate_requirement` 写入 `customer_demands`，字段以 `references/creator_candidate_pool_schema.csv` 的 `字段` 列为准。
- 达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`；字段从需求主表继承；候选中间层固定为 `creator_candidate_pool`。
- `validate_requirement.required` 至少需要解析字段或 `raw_messages` 之一。
- `validate_requirement.properties` 包含解析字段 + `raw_messages`、`project_context`、`existing_demand_id`、`existing_demand_version`，但 `id`、`demand_id`、`demand_version` 不作为媒介/Agent 新需求入参必填。
- `search_creators`、`rank_mcns` 下游调用使用上一步 `data.id`，不再强制 `demand_id/demand_version/platform`。
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
- 结果持久化不因缺少 `trace_id`、成功/失败字段关系或启发式语义疑似问题改写响应。
- 非 YPmcn 工具结果不受影响。

## 3. Skill 行为

用 mock 验证：

1. Brief 入口不等待用户确认；Agent 先读取运行时 schema，预检通过后直接调用 `validate_requirement`。
2. `validate_requirement` 返回 `draft` 时，只按 MCP 返回的缺失必填项和语义模糊点让媒介补充；返回 `ready` 后才用 `askuserquestion` 弹窗确认结构化 brief。
3. 请求体只使用 schema 已声明字段，不用试错调用探测参数。
4. ready/draft/失败分别按前端回复规范呈现，不泄露完整 JSON。
5. 工具缺失或 schema 冲突时返回 `integration_required`。

包外 Python 检查使用系统 `python3`，不依赖 `uv`：

```bash
python3 -m unittest discover -s tests -v
```

## 4. 真实 MCP 集成

在隔离测试数据上依次验证主链路，不可逆动作和风险接受前仍须用户通过 `askuserquestion` 明确授权：

- 每个工具只发送当前 schema 字段。
- 响应基础信封尽量具备 `success`、`data`、`error`、`trace_id`；MVP 阶段 hook 不因细项缺失阻断。
- `validate_requirement` 成功数据包含需求表主键 `data.id`；`demand_id/demand_version` 若返回，只作内部版本字段。
- `search_creators.data.id` 可作为 `rank_mcns({id})` 输入，`rank_mcns.data.id` 可作为 `create_with_distributions({id})` 输入。
- 中风险/风险提报分别使用两个真实布尔字段，且只在用户明确确认后设为 true。
- `rank_creators` 返回真实 `run_id`；`create_submission_batch` 复用该 ID。
- `get_recommendation_run_detail` 能按 `run_id` 查询结果。
- 写调用超时后不盲目重试，使用查询能力或 `trace_id` 核对。

## 5. 失败分类

记录为：`INPUT_CONTRACT`、`MISSING_TOOL`、`SCHEMA_CONFLICT`、`BUSINESS_NORMALIZATION`、`STATE_EVIDENCE`、`FRONTEND_LEAK`、`VERSION_CONFLICT`、`INVALID_PHASE`。

参数 schema 问题修插件/hook；业务解析错误修 MCP；不要在 Agent Prompt 中复制解析算法。
