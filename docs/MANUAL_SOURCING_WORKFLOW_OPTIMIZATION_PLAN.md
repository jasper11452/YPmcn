# `manual_source_creators` 手扒流程优化方案

## 结论

本方案不新增 Agent 可见 Tool，直接把仍在开发中的 `manual_source_creators` 改造成“启动或幂等复用当前需求的手扒任务”入口。Tool 的最小输入固定为：

```json
{
  "requirement_id": "<requirement_id>",
  "target_count": 4
}
```

`requirement_id` 用于服务端读取需求、平台、筛选条件、最新供给计划和当前工作流；`target_count` 表示本次需要手扒新增的达人数量。其余上下文均由 Provider 从权威数据和调用元数据推导，禁止 Agent 重复传递。

要保证“真的启动手扒”，不能只改输入 Schema 或提示词。Provider 必须先持久化可恢复的手扒任务，再返回真实 `task_id` 和 `status`。只有收到 `started`、`running` 或 `completed`，Agent 才能向用户报告手扒已启动。高风险供给确认后，先调用 `manual_source_creators`，成功后同轮继续 `rank_mcns`；手扒成功绝不能直接跳到询价外发。

本文是实施方案，不代表当前插件、Provider 或数据库已经完成这些改动。

## 目标与验收边界

### 目标

1. `search_creators` 判断为高风险且给出正数补量建议时，界面明确建议启动手扒。
2. 用户选择启动手扒后，同一轮实际调用 `manual_source_creators`，不只记录“已确认”。
3. Tool 调用携带用户看到并确认的新增数量。
4. Provider 原子创建或幂等复用可恢复任务，返回足以证明已启动的业务事实。
5. 手扒启动后继续 MCN 赛马；两条补量路径可以同时推进。
6. 企微询价仍使用独立的外发确认，供给确认不得隐式授权发送或重发。

### 不在本方案内

- 不新增 `start_manual_sourcing`、`confirm_supply_plan` 等 Agent 可见 Tool。
- 不在 Agent 侧定义供给风险阈值、目标倍数或手扒算法。
- 不让 Agent 传平台、筛选表达式、风险等级、搜索上下文或手扒结果数组。
- 不修改达人精排权重、MCN 排名算法或企微发送确认规则。
- 不把本地 Hook 状态当作 Provider 已创建任务的证据。

## 当前问题

当前链路不能保证启动手扒：

1. `manual_source_creators` 只接受 `requirement_id`，无法表达用户确认的补量数量。
2. Skill 将该 Tool 定义为“导入已经存在的人工结果”，不是启动任务。
3. `search_creators` 的本地状态只提取命中数和少数补量字段，不保存风险、供给计划身份或推荐动作。
4. “供给确认”仅把固定文案“确认并开始MCN赛马”映射为 `rank_mcns`；“调整拓展数量”没有数值传递和执行动作。
5. `manual_source_creators` 成功后，Hook 当前直接把 `next_action` 设为 `create_with_distributions`，会绕过应继续进行的 MCN 赛马和选择流程。
6. 当前 Provider 没有声明 `manual_source_creators` 的成功输出 Schema；单独看到 `success=true` 不能证明任务已经持久化或执行。

## 决策一：最小输入契约

正式输入 Schema 调整为：

```json
{
  "type": "object",
  "required": [
    "requirement_id",
    "target_count"
  ],
  "properties": {
    "requirement_id": {
      "type": "string",
      "minLength": 1
    },
    "target_count": {
      "type": "integer",
      "minimum": 1,
      "description": "本次需要手扒新增的达人数量"
    }
  },
  "additionalProperties": false
}
```

示例调用：

```json
{
  "requirement_id": "req-example",
  "target_count": 4
}
```

### 为什么只保留两个字段

| 不传字段 | 服务端事实源或处理方式 |
| --- | --- |
| `platform` | 从 `customer_demands` 按 `requirement_id` 读取 |
| `risk_level` / `reason` | 从最新供给计划重新计算并审计 |
| `search_context` | 从需求快照、字段映射和最新搜索代次生成 |
| `manual_results` | 由手扒执行器或人工结果库写入，Agent 不搬运 |
| `supply_plan_id` / `state_version` | Provider 在事务内锁定并复核当前计划；陈旧时拒绝启动 |
| `confirmed` | 布尔值不能证明确认；用户选项触发的实际 Tool 调用就是执行命令 |
| `operator_id` | 从 MCP 调用身份与审计元数据读取 |
| `idempotency_key` | 由宿主/MCP 中间层稳定生成并通过 metadata 传递 |

只保留 `requirement_id` 会导致用户调整的补量数无法传给 Provider；因此两个字段是本业务闭环的最小值。

## 决策二：Tool 的唯一业务语义

`manual_source_creators` 统一定义为：

> 针对当前需求和新增目标数量，创建或幂等复用一个手扒任务；执行器取得结果后完成硬筛、去重和候选入池。

一次调用只表达一个业务意图，不增加 `mode`：

- 没有活动任务：创建并启动任务；
- 已有相同目标的活动任务：返回同一任务，不重复启动；
- 相同幂等键、相同参数：重放原响应；
- 相同幂等键、不同参数：返回 `IDEMPOTENCY_CONFLICT`；
- 已有不同目标的活动任务：返回 `MANUAL_SOURCING_CONFLICT`，由用户确认是沿用还是调整，禁止静默覆盖；
- 已有完成结果：返回完成状态和真实入池数量，不创建重复任务。

旧版“由 Agent 传 `manual_results` 批量导入”的入口不再作为公开契约。执行器内部仍可复用已有的校验、写达人表、写 offer 和写候选池逻辑。

## 决策三：成功输出必须证明任务已启动

Provider 为该 Tool 声明固定输出 Schema。最小成功响应为：

```json
{
  "success": true,
  "data": {
    "task_id": "<real-task-id>",
    "requirement_id": "<requirement_id>",
    "target_count": 4,
    "status": "started",
    "operation": "created",
    "started_at": "2026-07-20T12:00:00+08:00",
    "accepted_count": 0
  },
  "error": null
}
```

字段约束：

- `task_id`：Provider 已持久化的真实任务主键，非随机展示值；
- `status`：只允许 `started`、`running`、`completed`；
- `operation`：只允许 `created` 或 `reused`；
- `target_count`：必须回显本次确认值；
- `accepted_count`：已经通过硬筛并入池的去重达人数量，任务刚启动时可以为 0；
- `started_at`：任务首次成功持久化的时间，复用时不得改写。

以下响应不能被 Agent 表述为“已启动”：

- 没有 `task_id`；
- `status` 为 `pending`、`unknown` 或缺失；
- 只有自然语言消息或 `success=true`；
- Provider/网络结果未知；
- 本地 Hook 自行推进状态但没有远程成功响应。

## 命令传递与工具调用

### 1. 搜索结果

`search_creators` 仍只接收需求 ID：

```json
{
  "id": "<requirement_id>"
}
```

Provider 的成功结果必须至少给出：

```json
{
  "demand_count": 5,
  "eligible_creator_count": 6,
  "supply_ratio": 1.2,
  "hard_shortfall_count": 0,
  "buffer_shortfall_count": 4,
  "supply_risk_level": "high_risk",
  "suggested_expansion_count": 4,
  "recommended_action": "mcn_and_manual"
}
```

风险阈值和 `buffer_shortfall_count` 由 Provider 的已批准策略计算。高风险时缺少 `suggested_expansion_count`，或返回 0 但没有可解释原因，Agent 不得再用 `max(demand-matched,0)` 伪装成建议；应显示供给计划不完整并停止执行。

### 2. 供给确认弹窗

高风险且建议补量为正数时使用：

```json
{
  "questions": [
    {
      "header": "供给确认",
      "question": "需求达人数量：5\n当前符合条件达人数量：6\n供需比：6/5（1.2:1）\n硬缺口：0\n风险缓冲缺口：4\n建议手扒新增：4\n\n请选择执行方案。",
      "options": [
        {
          "label": "启动手扒并开始MCN赛马",
          "description": "启动手扒补充4位，并继续MCN赛马"
        },
        {
          "label": "仅开始MCN赛马",
          "description": "暂不手扒，接受当前高供给风险"
        },
        {
          "label": "调整手扒数量",
          "description": "重新输入本次手扒新增数量"
        }
      ]
    }
  ]
}
```

弹窗仅确认供给动作，不包含“发送询价”或“重发询价”。

### 3. Hook 将选择转换为待执行命令

选择“启动手扒并开始MCN赛马”后，Hook 保存：

```json
{
  "last_user_command": "启动手扒并开始MCN赛马",
  "pending_manual_target_count": 4,
  "next_action": "manual_source_creators",
  "waiting_for": null
}
```

选择“仅开始MCN赛马”后：

```json
{
  "last_user_command": "仅开始MCN赛马",
  "next_action": "rank_mcns",
  "waiting_for": null
}
```

选择“调整手扒数量”后，使用一次参数确认弹窗取得正整数。提交后覆盖 `pending_manual_target_count` 并把 `next_action` 设为 `manual_source_creators`。取消、关闭、超时或非法值均不得调用 Tool。

### 4. Agent 同轮启动手扒

Agent 读取当前 Tool 格式后调用：

```json
mcp__ypmcn__manual_source_creators
{
  "requirement_id": "<requirement_id>",
  "target_count": 4
}
```

禁止把 `pending_manual_target_count` 之外的模型推断数值传给 Provider。Tool 失败、超时或结果未知时停止自动写入，按现有恢复规则让用户选择查询状态或结束；不得盲目重试。

### 5. 启动成功后继续 MCN 赛马

只有远程响应包含真实任务证据时，Hook 才保存：

```json
{
  "manual_sourcing_task_id": "<real-task-id>",
  "manual_sourcing_status": "started",
  "manual_sourcing_target_count": 4,
  "next_action": "rank_mcns",
  "waiting_for": null
}
```

Agent 随后在同一轮调用既有 `rank_mcns`。不得把 `next_action` 直接设为 `create_with_distributions`。

完整分支为：

```text
search_creators
  → 高风险供给结果
  → AskUserQuestion
  ├─ 启动手扒并开始MCN赛马
  │    → manual_source_creators(requirement_id, target_count)
  │    → Provider 返回真实 task_id + started/running/completed
  │    → rank_mcns
  ├─ 仅开始MCN赛马
  │    → rank_mcns
  └─ 调整手扒数量
       → 参数确认
       → manual_source_creators(requirement_id, adjusted_target_count)
       → rank_mcns
```

## Provider 最小实现

### 1. 调用前校验

Provider 在任何写入前完成：

1. `requirement_id` 唯一解析到存在且未关闭的需求；
2. 需求平台、筛选条件和当前候选池可读取；
3. 当前阶段尚未完成企微外发；
4. `target_count` 是正整数且不超过服务端配置的单次上限；
5. 锁定需求或当前供给计划后重新计算供给风险和缺口；
6. 当前供给已不需要补量时返回 `SUPPLY_PLAN_STALE`，附最新安全摘要且不创建任务；
7. 当前风险允许手扒，且没有冲突的活动任务。

这些条件不能交给 Hook 代替。Hook 可做体验层检查，但 Provider 必须重复验证。

### 2. 持久化任务后再返回

要保证任务可恢复，Provider 必须存在持久化任务事实。优先复用现有后端的真实任务/队列实体；如果当前没有任何可表示手扒任务的实体，则新增最小 `manual_sourcing_tasks` 业务表，而不是把聊天状态当任务表。

最小任务事实包括：

- `task_id`；
- `requirement_id`；
- `target_count`；
- `status`；
- `idempotency_key` 或稳定 operation identity；
- `created_at`、`started_at`、`completed_at`；
- `accepted_count`；
- `last_error_code`；
- 执行器返回的外部任务引用（如存在）。

创建任务、登记幂等操作和提交启动命令必须形成可对账边界：

1. MCP 中间层认领稳定幂等键；
2. 同事务写任务和本地幂等记录；
3. 任务提交后由执行器领取；
4. 只有任务已经持久化且执行器可领取时返回 `started`；
5. 队列投递结果未知时返回 `WRITE_RESULT_UNKNOWN`，不得宣称启动成功；
6. 重复同 key/hash 返回同一 `task_id` 和首次 `started_at`。

如果 Provider 只能同步执行手扒，则必须在响应前完成真实采集和入池；此时返回 `completed`。没有持久任务也没有同步结果时，不能实现“保证启动”。

### 3. 执行、硬筛和入池

执行器从权威需求生成搜索上下文：

1. 按平台和 `field_match_mapping` 编译与 `search_creators` 相同的硬条件；
2. 从批准的手扒来源获取候选；
3. 回源并执行平台、价格、返点、地域、粉丝、档期、授权和合规硬筛；
4. 按平台逻辑身份去重，同一达人跨来源只形成一个逻辑候选；
5. 写平台达人表、`creator_supply_offers` 和 `creator_candidate_pool`；
6. `source_type` / `manual_sourced` 明确标记人工来源并保留原始 provenance；
7. 只有通过硬筛且成功入池的达人计入 `accepted_count`；
8. 达到 `target_count`、来源耗尽、截止时间到达或明确失败后结束任务。

向量和 rerank 只能参与软召回或相关性排序，不能补回硬筛失败的达人。

### 4. 状态与恢复

任务状态最小集合：

```text
started → running → completed
                  ↘ failed
started/running → cancelled
```

`get_workflow_state` 聚合真实任务事实，至少返回任务状态、目标数和已入池数。Agent 不高频轮询；在用户恢复会话、结果未知对账或 Provider 明确要求刷新时查询。

手扒结果完成后，应刷新当前需求的候选供给统计。可以由执行器在同一事务边界更新供给快照，也可以由后续明确的新一代 `search_creators` 重新计算；不得继续展示启动前的 6/5 和高风险结论。

## 插件和状态投影改造

### `search_creators` 成功后

Hook 增加提取并保存：

- `supply_risk_level`；
- `hard_shortfall_count`；
- `buffer_shortfall_count`；
- `suggested_expansion_count`；
- `recommended_action`。

风险字段缺失或互相矛盾时，`next_action` 进入供给结果恢复，不生成 0 补量建议。

### `AskUserQuestion` 成功后

精确识别三项供给命令，并保存本次展示的 `suggested_expansion_count`。调整数量时只接受正整数，不从自由文本猜测多个数值。

### `manual_source_creators` 成功后

只有输出满足固定 Schema 且包含真实任务证据，才设置：

```text
manual_sourcing_status = returned status
next_action = rank_mcns
waiting_for = null
```

失败时保持当前阶段并设置 `recover_manual_source_creators`；结果未知时只允许状态对账，不重放启动命令。

## 用户展示

启动成功后只展示业务事实，不展示内部 ID：

```markdown
### 手扒任务已启动
- 目标新增达人：4 位
- 当前状态：已启动
- 下一步：继续 MCN 赛马；手扒结果入池后重新评估供给风险
```

任务复用时展示“已存在进行中的手扒任务，本次沿用”，不能声称又启动了一次。

失败时展示真实安全错误码和恢复选项，不能把本地 `next_action` 当成远程成功。

## 询价外发边界

手扒供给确认只授权手扒和 MCN 赛马，不授权 `create_with_distributions`。完整顺序保持：

```text
供给确认
→ 手扒启动（可选）
→ MCN 赛马与选择
→ 询价字段选择
→ create_with_distributions 本地预检
→ 独立“企微外发确认”
→ 同参数正式外发
```

任何“确认后开始 MCN 赛马并重发询价”的合并文案都应删除。

## 错误与恢复

| 场景 | 错误或结果 | 行为 |
| --- | --- | --- |
| 需求不存在或已关闭 | `REQUIREMENT_NOT_FOUND` / `STATE_CONFLICT` | 不创建任务，返回需求处理 |
| `target_count < 1` 或超上限 | `INVALID_INPUT` | 参数确认，不猜测修正 |
| 最新供给已不需要补量 | `SUPPLY_PLAN_STALE` | 展示最新供给，重新确认 |
| 已有相同活动任务 | 成功，`operation=reused` | 返回同一任务，不重复创建 |
| 已有不同目标活动任务 | `MANUAL_SOURCING_CONFLICT` | 让用户选择沿用或调整 |
| 明确未写入的后端失败 | 真实后端错误码 | 可由用户选择重试一次 |
| 写入或投递结果未知 | `WRITE_RESULT_UNKNOWN` | 只对账，不重发 |
| 任务执行中部分结果入池 | `running` + `accepted_count` | 保留任务，继续 MCN 流程 |
| 来源耗尽但未达到目标 | `completed` + 缺口原因 | 展示实际结果和剩余风险 |

## 修改范围与实施顺序

正式实施按以下顺序进行：

1. **Spec**
   - 修改 `spec/mcp.json` 中 `manual_source_creators` 输入和固定输出 Schema；
   - 修改 `spec/workflow.json` 的供给确认、手扒启动和后续 MCN 转移；
   - 补充错误码、状态字段和必要的数据库任务实体契约；
   - 更新 Spec hash 和生成引用。
2. **Provider / Database**
   - 实现两字段 handler、事务校验、任务持久化、幂等与执行器；
   - 实现硬筛、去重、入池、状态恢复和真实响应；
   - 如无现成任务实体，再实施经过批准的最小 migration。
3. **Hook / Skill**
   - 解析供给风险与补量；
   - 增加三项供给命令映射和调整数量流程；
   - 将手扒成功后的 `next_action` 改为 `rank_mcns`；
   - 更新 `manual_source_creators.json`、主链说明和用户文案。
4. **Tests**
   - 增加 Provider 单元/集成、Hook 回放、契约、幂等和 Live E2E；
   - 验证失败与未知结果不会伪造启动或重复任务。
5. **Release**
   - 先部署 Provider 并验证 `tools/list`；
   - 再发布插件；
   - 使用隔离需求和测试执行器灰度，不触达生产联系人。

插件不得先于 Provider 新契约上线，否则 Agent 会发送 Provider 不接受的 `target_count`。

## 测试矩阵

### Contract

1. 缺 `requirement_id` 拒绝；
2. 缺 `target_count` 拒绝；
3. `target_count=0`、小数、字符串或负数拒绝；
4. 额外字段拒绝；
5. 成功输出缺 `task_id/status/target_count` 时契约测试失败。

### Hook 回放

1. 高风险 6/5、建议 4，选择“启动手扒并开始MCN赛马”后，记录 `next_action=manual_source_creators` 和目标 4；
2. 随后的 Tool 参数严格为 `{requirement_id,target_count}`；
3. 真实 `started` 结果后转 `rank_mcns`；
4. `success=true` 但无任务证据时进入恢复，不得显示已启动；
5. “仅开始MCN赛马”不调用手扒；
6. “调整手扒数量”把用户确认的正整数传给 Tool；
7. 取消、关闭和超时不调用 Tool；
8. 手扒成功不会进入 `create_with_distributions`。

### Provider / Database

1. 同幂等键、同参数并发两次只创建一个任务并返回同一 `task_id`；
2. 同幂等键改 `target_count` 返回冲突；
3. Provider 在任务创建前重新计算供给，陈旧计划不启动；
4. 任务可从新会话通过 `get_workflow_state` 恢复；
5. 同一达人跨手扒来源和 MCN 去重，但来源记录都保留；
6. 硬筛失败达人不进入候选池；
7. 队列投递未知时不重复投递；
8. 完成数小于目标时返回真实缺口原因。

### Live E2E

隔离测试需求固定覆盖：

```text
需求 5 → 搜索命中 6 → Provider 判高风险 → 建议手扒 4
→ 用户确认启动手扒并开始 MCN 赛马
→ manual_source_creators(requirement_id,4)
→ 返回真实 task_id/status=started
→ rank_mcns
→ 手扒结果入池并刷新供给
→ 单独企微外发确认
```

同时核对数据库任务行、ledger、候选池、offer、平台达人记录、Hook 状态和 Provider trace。任何一层没有真实启动证据，E2E 失败。

## 最终验收标准

以下条件全部满足，才可宣称“高风险供给能够启动手扒”：

1. Tool 公开输入只有 `requirement_id` 和 `target_count`；
2. 高风险供给弹窗明确提供启动手扒选项，并显示确认数量；
3. 用户提交后同轮产生真实 `manual_source_creators` Tool call；
4. Provider 持久化唯一任务并返回真实 `task_id` 与允许状态；
5. 重复调用不产生重复任务，未知结果不盲重试；
6. Hook 只在远程任务证据完整时显示启动成功；
7. 手扒成功后继续 `rank_mcns`，不跳过 MCN 流程；
8. 供给确认不授权企微外发；
9. 手扒结果经过同一套硬筛、去重和 provenance 规则后入池；
10. Contract、Hook、Provider、Database 和隔离 Live E2E 全部通过。

## 回滚

- Provider 保留旧一字段调用兼容只能用于灰度读取，不能在正式插件继续发送；正式切换后缺 `target_count` 必须拒绝，避免再次出现隐式补量。
- 关闭手扒启动 feature flag 后，供给弹窗退回“仅开始 MCN 赛马”，不得继续展示可启动手扒。
- 回滚插件时不删除已经创建的任务或候选；任务按真实状态完成、取消或人工处理。
- 数据库 migration 如存在，只回滚未使用的结构，不删除审计、任务或已入池业务事实。
