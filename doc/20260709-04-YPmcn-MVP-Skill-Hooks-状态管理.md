# YPmcn MVP Skill、Hooks 和状态管理

> 更新日期：2026-07-09  
> 目标：说明 Agent 为什么会这样走、Hooks 拦什么、状态怎么保存和恢复。

## 1. 总结

当前 MVP 的运行方式：

1. Skill 是 Agent 的流程导航。
2. Hooks 是工具调用前后的硬护栏。
3. MCP 响应里的业务 ID 是链路事实。
4. 数据库表是可恢复事实源。
5. `workflow_state/allowed_actions` 是可选增强；有就遵守，没有不判错。

一句话：

```text
Skill 告诉 Agent 该做什么 -> Agent 调 MCP -> Hooks 检查是否允许 -> MCP 读写旧业务表 -> 返回 data.id/run_id 等业务 ID -> Agent 按当前 schema 继续
```

## 2. Skill 的作用

主文件：

```text
YPmcn/skills/media-assistant/SKILL.md
```

Skill 负责定义：

| 内容 | 当前规则 |
|---|---|
| 工具数量 | 保留旧工具名；`get_workflow_state` 是兼容参考，不作为必需工具 |
| 入参权威 | 每次读取运行时 `inputSchema` |
| Brief 入口 | 直接调用 `validate_requirement`，不先弹窗 |
| 必填项 | `platform`、`submission_deadline_at`、`raw_messages_json`、预算区间、返点区间、`quantity_total` 必须齐全 |
| 额外需求 | 参考 `creator_candidate_pool_schema.csv` 匹配需求表/达人字段，并让用户确认；达人资源库按 `xhs_creator_accounts` / `dy_creator_accounts` 拆表 |
| ID 规则 | 下游按运行时 schema 使用上一步 `data.id`；这个 `id` 映射旧业务表主键，不代表新表名；`run_id`、`inquiry_id`、`batch_no` 等仍按工具返回使用 |
| 人工节点 | 用 `askuserquestion`，不得跳过 |
| 响应判断 | 看 `success` + 业务 ID，不因 trace 细项阻断 |
| 保密回复 | 不暴露完整 JSON、算法、数据库内部状态 |

## 3. Skill 引导的完整流程

```text
validate_requirement
-> confirm-extra-field-mapping
-> confirm-structured-brief
-> search_creators
-> rank_mcns
-> confirm-supply-ratio
-> mcn-select-for-wechat
-> confirm-form-fields
-> confirm-wecom-permission
-> draft-wecom-message-from-requirement
-> mcn-wechat-send
-> create_with_distributions preview
-> create_with_distributions send
-> wait-mcn-return-and-manual-source
-> rank_creators
-> confirm-risky-submission (有风险时)
-> create_submission_batch
-> record_client_feedback
```

每个节点对应关系：

| 流程节点 | Agent 做什么 | MCP/DB 做什么 | Hooks 做什么 |
|---|---|---|---|
| `validate_requirement` | 把必填项、区间字段和可确定额外需求解析为 JSON | 写 `customer_demands`，返回 `data.id`，可带 `demand_id/demand_version` 版本字段 | 检查基础类型、平台枚举、raw_messages 可序列化 |
| `confirm-extra-field-mapping` | 按 CSV 字段确认额外需求映射 | 可写字段确认状态 | 不替代业务确认 |
| `confirm-structured-brief` | 弹窗确认结构化需求 | 不写库或写确认状态 | 不强制 trace 细项 |
| `search_creators` | 传 `validate_requirement.data.id` | 读取 `customer_demands` 非空字段，与 `xhs_creator_accounts` / `dy_creator_accounts` 匹配，写 `creator_candidate_pool` | 阻断缺上游 `id` 或 schema 外字段 |
| `rank_mcns` | 传 `search_creators.data.id` | 读取候选和 MCN 数据，写 `mcn_recommendation_items`，返回供需关系、建议手扒比例、建议询价 MCN 列表 | 阻断缺上游 `id`；中风险要确认字段 |
| 发送前 gate | 弹窗确认供需关系、手扒比例、MCN 名单、表单、权限、内容 | 可写确认状态 | 未确认时阻断分发 |
| `draft-wecom-message-from-requirement` | 根据 `validate_requirement.data.id` 读取需求表非空字段，拟写企微消息 | 不调用发送接口 | 只是 Agent 准备动作 |
| `create_with_distributions` | 使用固定接口字段，带 `supplierIds` 和按 MCN 的 `prefillRowsBySupplier` | 写分发/询价，为每个 MCN 生成唯一填报链接 | 检查时间、supplierIds、usageScope、角色、禁直连 |
| `wait-mcn-return-and-manual-source` | 分发成功后停，等待机构回填；需要手扒则同步启动 | 回填和手扒写回候选池 | 等待锁期间只放行 askuserquestion |
| `rank_creators` | 回填和手扒回收后传当前候选/回填上下文 `id` | 统一去重、筛选、精排，写 `recommendation_runs` / `creator_recommendation_items` | 要求分发成功和精排确认 |
| `create_submission_batch` | 传 `run_id` | 写 `creator_submissions`，生成首批提报表给媒介看 | 风险账号需 `allow_need_confirm_with_risk` |
| `record_client_feedback` | 传客户反馈 | 更新 `creator_submissions` 反馈字段；核心需求变化时写 `customer_demands` 新版本 | 按 schema 和状态放行 |

## 4. Hooks 当前工作方式

实现文件：

```text
YPmcn/src/index.ts
```

注册的 hooks：

| Hook | 当前作用 |
|---|---|
| `before_tool_call` | 工具调用前门控 |
| `after_tool_call` | 缓存成功状态，分发成功后设置等待锁 |
| `tool_result_persist` | 只缓存状态；不再改写缺 trace 或语义疑似结果 |
| `message_received` | 收到新用户消息后清除分发等待锁 |
| `agent_turn_prepare` | 给 Agent 注入当前状态摘要 |

## 5. `before_tool_call` 门控

### 5.1 `validate_requirement`

当前只做轻量检查：

- `platform` 若传，必须是 `xhs` 或 `dy`。
- 复数别名如 `platforms` 会被阻断，要求用 schema 字段。
- CSV 必填字段“传了就检查类型”。必填项是否齐全由 Agent 自检和 MCP 业务校验共同保证；缺必填项时不可继续。
- 需求主表字段按 `creator_candidate_pool_schema.csv` 追加的需求字段执行，落点是 `customer_demands`；达人资源库按 `xhs_creator_accounts` / `dy_creator_accounts` 拆表并继承同一 CSV 字段口径。
- `raw_messages` 必须可 JSON 序列化。
- `trace_id`、`parsed_requirement` 等不再因为 schema 外就阻断。

目的：防止明显格式错误，不让 hooks 替代 MCP 的业务解析。

### 5.2 链式业务 ID

当前运行时 hook 只要求关键下游工具带上上一步成功响应里的非空 `id`；这个 `id` 映射旧业务表主键，不代表新增表名。`demand_id/demand_version` 如果同时存在，不因它们本身阻断，但也不能替代主链路 `id`。

| 工具 | 必须传 | 禁止 |
|---|---|---|
| `search_creators` | `id`，来自 `validate_requirement.data.id` | Agent 自造筛选条件或 schema 外重复需求字段 |
| `rank_mcns` | `id`，来自 `search_creators.data.id` | 跳过候选池直接按需求排序 MCN |
| `rank_creators` | 当前候选/回填上下文 `id` + `ranking_strategy` | 企微分发未完成或回填未回收时调用 |
| `manual_source_creators` | 当前需求/候选上下文 `id` + 手扒结果 | 用虚拟达人补量 |

`create_with_distributions` 的字段以企微发送接口为准；`id` 来自 `rank_mcns.data.id`，发送供应商来自已确认的 `rank_mcns.inquiry_advice` / `mcn_recommendation_items`。

### 5.3 状态守护

如果 MCP 返回了 `workflow_state.allowed_actions`，hooks 会把它当白名单：

```json
{
  "workflow_state": {
    "phase": "mcn_planning",
    "allowed_actions": ["create_with_distributions"]
  }
}
```

此时调用不在白名单里的业务工具会被阻断。

如果没有 `workflow_state`，hooks 不伪造服务端状态，只使用本地已知等待锁和完成记录。

### 5.4 风险 gate

当前只认真实运行时字段：

| 场景 | 工具字段 |
|---|---|
| MCN 中风险继续 | `rank_mcns.medium_risk_confirmed === true` |
| 风险账号提报 | `create_submission_batch.allow_need_confirm_with_risk === true` |

不要求 Agent 构造 `gate_id/operator_id/confirmation_type`。

### 5.5 企微分发门控

`create_with_distributions` 调用前检查：

| 检查项 | 规则 |
|---|---|
| 正式工具名 | 只能用 `create_with_distributions` |
| 禁止直连 | Bash/PowerShell/curl 访问 `/api/projects/create-with-distributions/` 被阻断 |
| 时间 | `deadline/remindAt` 必须未来、带时区 ISO 8601 |
| `supplierIds` | 必须非空字符串数组 |
| `usageScope` | 缺失补 `project`；`项目` 会归一；其他值阻断 |
| 角色 | 有角色上下文时只允许 `media/procurement` |
| 发送前 gate | 没确认比例、名单、表单、权限、内容时阻断 |

业务上还必须满足：

- Agent 已根据 `validate_requirement.data.id` 读取 `customer_demands` 非空字段并拟写企微消息。
- 用户已确认消息内容。
- 每个 MCN/供应商都有自己的填报链接生成路径。
- `prefillRowsBySupplier` 只包含候选池中属于当前 MCN/供应商的达人。
- 企微发送接口字段固定，不通过 hooks 或 Agent 自造新字段。

## 6. `after_tool_call` 和等待锁

`create_with_distributions` 正式发送成功后：

1. 记录这个 `toolCallId` 已完成，避免重复处理。
2. 记录当前 session 已完成项目分发。
3. 设置等待锁。
4. 后续除 `askuserquestion` 外，其他工具调用都会被阻断，直到用户消息或明确继续。

`preview_only: true` 不设置等待锁。

发送失败不设置等待锁。

收到新的用户消息后，`message_received` 清除等待锁。业务上，清锁不等于可以直接精排；仍需要确认机构回填和手扒结果已经回收到候选池。

## 7. `tool_result_persist`

当前 MVP 已放宽：

- 不因缺少 `trace_id` 改写结果。
- 不因 `success/error/data` 信封细项不完美阻断。
- 不做“语义疑似错误”的启发式改写。
- 只在能解析出 `workflow_state` 时缓存它，供下一次调用参考。

这符合“先跑通”的原则。业务解析错，应修 MCP 或字段映射，不放在 hooks 里卡主链路。

## 8. 状态管理

### 8.1 状态来源

当前有四个状态来源：

| 来源 | 用途 |
|---|---|
| MCP 响应业务 ID | 最可靠，决定下一步 ID |
| 数据库业务表 | 可恢复事实源 |
| 可选 `workflow_state/allowed_actions` | 服务端状态增强 |
| Hooks 本地缓存 | 会话内等待锁、已完成步骤摘要 |

### 8.2 最小状态对象

```json
{
  "phase": "requirement_ready",
  "requirement_id": "demand_123",
  "candidate_pool_id": null,
  "mcn_recommendation_id": null,
  "inquiry_ids": [],
  "run_id": null,
  "batch_no": null,
  "project_distribution_completed": false,
  "wait_gate": null
}
```

### 8.3 阶段推进

| 阶段 | 进入条件 | 下一步 |
|---|---|---|
| `requirement_ready` | `validate_requirement` 成功并返回 `data.id` | brief 确认后 `search_creators` |
| `candidate_pool_ready` | `search_creators` 成功写 `creator_candidate_pool` | `rank_mcns` |
| `mcn_planning` | `rank_mcns` 成功 | 展示供需关系、建议手扒比例、MCN 列表，并进入发送前 gate |
| `waiting_mcn_return` | `create_with_distributions` 成功 | 停，等机构回填和手扒 |
| `recommendation_ready` | 机构回填和手扒回收到候选池后 `rank_creators` 成功 | 风险确认或首批提报 |
| `submission_batch_ready` | `create_submission_batch` 成功 | 等客户反馈 |
| `feedback_routing` | `record_client_feedback` 成功 | 补批/重排/需求变更 |

### 8.4 恢复策略

1. 优先使用当前会话里最近成功响应的业务 ID。
2. 有 `run_id` 时调用 `get_recommendation_run_detail`。
3. 有达人账号时调用 `get_creator_detail`。
4. 只有不明业务 ID 时，根据最近工具响应判断类型；判断不了就停。
5. 写操作超时或断连，不自动重试写工具。

## 9. 自检脚本

当前 Skill 要求 Agent 在关键调用前跑自检：

| 脚本 | 输入 | 作用 |
|---|---|---|
| `uv run scripts/check_flow_order.py` | `current_phase`, `intent_tool`, `visited_steps` | 检查是否跳步骤 |
| `uv run scripts/check_requirement_params.py` | `params`, `raw_text` | 检查平台、金额单位、返点小数 |
| `uv run scripts/check_distribution_readiness.py` | `gate_state`, `params` | 检查分发前 gate 和发送字段 |

这些脚本是 Agent 自检，不替代后端校验。

`check_requirement_params.py` 的业务目标应覆盖当前必填口径：预算/单价和返点都按区间字段表达，缺 `platform/submission_deadline_at/raw_messages_json/budget_min_cents/budget_max_cents/budget_raw/rebate_min_rate/rebate_max_rate/rebate_raw/quantity_total` 时不可继续。

## 10. 当前不再采用的新口径

| 新口径 | 当前处理 |
|---|---|
| 把链式 `id` 解释成新表名/新数据模型 | 撤回；链式 `id` 只映射旧业务表主键，表名仍沿用旧设计 |
| 新建 `requirements/candidate_pools/candidate_items/mcn_plans/rank_runs` 契约表名 | 撤回，沿用 `customer_demands/creator_candidate_pool/mcn_recommendation_items/recommendation_runs/creator_recommendation_items/creator_submissions` 等旧表名 |
| 统一 `creators` 达人资源库 | 撤回，达人资源库分 `xhs_creator_accounts` / `dy_creator_accounts`，字段继承 `creator_candidate_pool_schema.csv` |
| `validate_requirement` 只允许 4 个字段 | 已放宽为按运行时 schema、CSV 字段和基础类型 |
| 缺 `trace_id` 改写成错误 | 不再改写 |
| 语义疑似错误由 hook 改写 | 不再改写 |
| `requireApproval` 由 hook 直接弹 | 当前依赖 Agent 层 `askuserquestion` |
| 分发后创建 Cron 提醒 | 当前 hooks 不创建 Cron，只设置等待锁 |

## 11. 开发联调检查清单

| 检查项 | 通过标准 |
|---|---|
| 工具 schema | 保留旧工具名；`get_workflow_state` 可见时作为兼容只读工具 |
| 需求入库 | `validate_requirement` 写 `customer_demands` 并返回 `data.id`；`demand_id/demand_version` 只作版本字段 |
| 链式 ID | `search_creators/rank_mcns/create_with_distributions` 使用上一步 `data.id`，映射旧表主键 |
| 缺 ID 阻断 | 需要上游 `id` 的下游工具缺 `id` 会被拦；不会因为同时带 `demand_id/demand_version` 阻断 |
| 需求必填 | 必填项齐全，预算/单价和返点是区间 |
| 需求主表 | `customer_demands` 字段口径来自 `creator_candidate_pool_schema.csv` 追加的需求字段 |
| 达人资源库 | `xhs_creator_accounts` / `dy_creator_accounts` 拆表，字段从同一 CSV 继承 |
| 额外需求 | 按 `creator_candidate_pool_schema.csv` 匹配并经用户确认 |
| MCN 排序 | 前端展示供需关系、建议手扒比例、建议询价 MCN 列表 |
| 企微字段 | 固定接口字段符合要求，包含 `deadline/remindAt/supplierIds/usageScope`，不自造新字段 |
| 预填达人 | 每个 MCN 只预填候选池中属于自己的达人 |
| 分发等待 | 正式发送后等待机构回填和手扒，除 `askuserquestion` 外不继续工具 |
| 精排前置 | 未分发成功、未回收回填/手扒结果不能 `rank_creators` |
| trace 细项 | 缺失不阻断主流程 |
| 测试 | `npm test` 通过 |
