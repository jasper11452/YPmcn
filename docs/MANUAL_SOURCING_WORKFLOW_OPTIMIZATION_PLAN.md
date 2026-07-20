# `manual_source_creators` 达人拓展流程优化方案

## 结论

本方案不新增 Agent 可见 Tool，直接把仍在开发中的 `manual_source_creators` 改造成“启动或幂等复用当前需求的达人拓展任务”入口。Tool 的最小输入固定为：

```json
{
  "requirement_id": "<requirement_id>",
  "target_count": 4
}
```

`requirement_id` 用于服务端读取需求、平台、筛选条件、最新供给计划和当前工作流；`target_count` 表示本次需要达人拓展新增的达人数量。其余上下文均由 Provider 从权威数据和调用元数据推导，禁止 Agent 重复传递。

要保证“真的启动达人拓展”，不能只改输入 Schema 或提示词。达人拓展前必须先有询价关联：高风险供给确认后先调用 `rank_mcns`，由它为同一需求持久化关联并返回真实 `inquiry_id`；只有拿到该证据才同轮调用 `manual_source_creators`。Provider 必须持久化可恢复、关联该询价的达人拓展任务，再返回真实 `task_id`、相同 `inquiry_id` 和 `status`。只有收到匹配证据及 `started`、`running` 或 `completed`，Agent 才能报告达人拓展已启动。达人拓展成功后进入 MCN 确认，绝不能直接跳到询价外发。

实施状态（3.4.0）：本仓库已完成目标输入契约、`rank_mcns → inquiry_id → manual_source_creators` 命令传递、Hook 询价/任务证据门禁、Skill 文案和本地回放测试；2026-07-20 只读 Provider 检查确认远端仍是一字段契约，尚无 `target_count`。`rank_mcns.inquiry_id` 属于未广告输出，仍须写入 E2E 验证。本仓库不含生产 Provider、任务执行器或数据库 migration，因此生产启用保持阻断，必须先部署询价关联、两字段契约、真实任务证据并通过隔离 Live E2E。

## 目标与验收边界

### 目标

1. `search_creators` 判断为高风险且给出正数补量建议时，界面明确建议启动达人拓展。
2. 用户选择启动达人拓展后，同一轮先实际调用 `rank_mcns`；只在它返回当前需求的 `inquiry_id` 后调用 `manual_source_creators`。
3. Tool 调用携带用户看到并确认的新增数量。
4. Provider 原子创建或幂等复用可恢复任务，返回足以证明已启动的业务事实。
5. 达人拓展启动后进入已完成排序结果的 MCN 确认；两条补量路径可以同时推进。
6. 企微询价仍使用独立的外发确认，供给确认不得隐式授权发送或重发。

### 不在本方案内

- 不新增 `start_manual_sourcing`、`confirm_supply_plan` 等 Agent 可见 Tool。
- 不在 Agent 侧定义供给风险阈值、目标倍数或达人拓展算法。
- 不让 Agent 传平台、筛选表达式、风险等级、搜索上下文或达人拓展结果数组。
- 不修改达人精排权重、MCN 排名算法或企微发送确认规则。
- 不把本地 Hook 状态当作 Provider 已创建任务的证据。

## 当前问题

当前链路不能保证启动达人拓展：

1. `manual_source_creators` 只接受 `requirement_id`，无法表达用户确认的补量数量。
2. Skill 将该 Tool 定义为“导入已经存在的人工结果”，不是启动任务。
3. `search_creators` 的本地状态只提取命中数和少数补量字段，不保存风险、供给计划身份或推荐动作。
4. “供给确认”仅把固定文案“确认并开始MCN排序”映射为 `rank_mcns`；“调整拓展数量”没有数值传递和执行动作。
5. 已知直接调用 `manual_source_creators` 会返回 `INQUIRY_NOT_FOUND`；原设计却把它排在 `rank_mcns` 之前，尚未建立所需询价关联。
6. `manual_source_creators` 成功后若直接进入外发，会绕过 MCN 选择；正确下一步应是确认已经完成的 `rank_mcns` 结果。
7. 当前 Provider 没有声明 `rank_mcns` 或 `manual_source_creators` 的成功输出 Schema；单独看到 `success=true` 不能证明询价或任务已经持久化。

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
      "description": "本次需要达人拓展新增的达人数量"
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
| `manual_results` | 由达人拓展执行器或人工结果库写入，Agent 不搬运 |
| `supply_plan_id` / `state_version` | Provider 在事务内锁定并复核当前计划；陈旧时拒绝启动 |
| `confirmed` | 布尔值不能证明确认；用户选项触发的实际 Tool 调用就是执行命令 |
| `operator_id` | 从 MCP 调用身份与审计元数据读取 |
| `idempotency_key` | 由宿主/MCP 中间层稳定生成并通过 metadata 传递 |

只保留 `requirement_id` 会导致用户调整的补量数无法传给 Provider；因此两个字段是本业务闭环的最小值。`inquiry_id` 不新增为第三个输入字段：它必须由前一步 `rank_mcns` 在服务端持久化并返回，达人拓展按同一 `requirement_id` 解析该关联，并在回执中回显以供核对。

## 决策二：Tool 的唯一业务语义

`manual_source_creators` 统一定义为：

> 针对当前需求、`rank_mcns` 已创建的询价关联和新增目标数量，创建或幂等复用一个达人拓展任务；执行器取得结果后完成硬筛、去重和候选入池。

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
    "inquiry_id": "<inquiry-id-returned-by-rank_mcns>",
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
- `inquiry_id`：必须与同一需求最近一次成功 `rank_mcns` 返回值一致；
- `status`：只允许 `started`、`running`、`completed`；
- `operation`：只允许 `created` 或 `reused`；
- `target_count`：必须回显本次确认值；
- `accepted_count`：已经通过硬筛并入池的去重达人数量，任务刚启动时可以为 0；
- `started_at`：任务首次成功持久化的时间，复用时不得改写。

以下响应不能被 Agent 表述为“已启动”：

- 没有 `task_id`；
- 没有 `inquiry_id`，或与 `rank_mcns` 返回值不一致；
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
      "question": "需求达人数量：5\n当前符合条件达人数量：6\n供需比：6/5（1.2:1）\n硬缺口：0\n风险缓冲缺口：4\n建议达人拓展新增：4\n\n请选择执行方案。",
      "options": [
        {
          "label": "启动达人拓展并开始MCN排序",
          "description": "启动达人拓展补充4位，并继续MCN排序"
        },
        {
          "label": "仅开始MCN排序",
          "description": "暂不达人拓展，接受当前高供给风险"
        },
        {
          "label": "调整达人拓展数量",
          "description": "重新输入本次达人拓展新增数量"
        }
      ]
    }
  ]
}
```

弹窗仅确认供给动作，不包含“发送询价”或“重发询价”。

### 3. Hook 将选择转换为待执行命令

选择“启动达人拓展并开始MCN排序”后，Hook 保存：

```json
{
  "last_user_command": "启动达人拓展并开始MCN排序",
  "pending_manual_target_count": 4,
  "next_action": "rank_mcns",
  "waiting_for": null
}
```

选择“仅开始MCN排序”后：

```json
{
  "last_user_command": "仅开始MCN排序",
  "next_action": "rank_mcns",
  "waiting_for": null
}
```

选择“调整达人拓展数量”后，使用一次参数确认弹窗取得正整数。提交后覆盖 `pending_manual_target_count` 并把 `next_action` 设为 `rank_mcns`。取消、关闭、超时或非法值均不得调用 Tool。

### 4. Agent 先执行 MCN排序并取得询价关联

Agent 读取当前 Tool 格式后先调用 `rank_mcns`。只有成功响应返回同一需求的非空 `inquiry_id`，Hook 才保存：

```json
{
  "rank_mcn_inquiry_id": "<real-inquiry-id>",
  "next_action": "manual_source_creators",
  "waiting_for": null
}
```

缺少 `inquiry_id`、需求不一致、失败、超时或结果未知时进入 `recover_rank_mcns`，保留待执行数量但不得调用达人拓展。

### 5. Agent 同轮启动关联达人拓展

`rank_mcns` 询价证据完整后调用：

```json
mcp__ypmcn__manual_source_creators
{
  "requirement_id": "<requirement_id>",
  "target_count": 4
}
```

禁止把 `pending_manual_target_count` 之外的模型推断数值传给 Provider。Tool 失败、超时或结果未知时停止自动写入，按现有恢复规则让用户选择查询状态或结束；不得盲目重试。

### 6. 启动成功后进入 MCN 确认

只有远程响应包含真实任务证据时，Hook 才保存：

```json
{
  "manual_sourcing_task_id": "<real-task-id>",
  "manual_sourcing_inquiry_id": "<same-inquiry-id>",
  "manual_sourcing_status": "started",
  "manual_sourcing_target_count": 4,
  "next_action": "confirm_mcn_selection",
  "waiting_for": "user"
}
```

Agent 不再重复调用 `rank_mcns`；它已经在达人拓展前完成。不得把 `next_action` 直接设为 `create_with_distributions`。

完整分支为：

```text
search_creators
  → 高风险供给结果
  → AskUserQuestion
  ├─ 启动达人拓展并开始MCN排序
  │    → rank_mcns
  │    → Provider 返回真实 inquiry_id
  │    → manual_source_creators(requirement_id, target_count)
  │    → Provider 回显相同 inquiry_id + 真实 task_id + started/running/completed
  │    → MCN 确认
  ├─ 仅开始MCN排序
  │    → rank_mcns
  │    → MCN 确认
  └─ 调整达人拓展数量
       → 参数确认
       → rank_mcns
       → Provider 返回真实 inquiry_id
       → manual_source_creators(requirement_id, adjusted_target_count)
       → MCN 确认
```

## Provider 最小实现

### 1. 调用前校验

Provider 在任何写入前完成：

1. `requirement_id` 唯一解析到存在且未关闭的需求；
2. 同一需求的 `rank_mcns` 已成功持久化且唯一解析到非空 `inquiry_id`；
3. 需求平台、筛选条件和当前候选池可读取；
4. 当前阶段尚未完成企微外发；
5. `target_count` 是正整数且不超过服务端配置的单次上限；
6. 锁定需求或当前供给计划后重新计算供给风险和缺口；
7. 当前供给已不需要补量时返回 `SUPPLY_PLAN_STALE`，附最新安全摘要且不创建任务；
8. 当前风险允许达人拓展，且没有冲突的活动任务。

这些条件不能交给 Hook 代替。Hook 可做体验层检查，但 Provider 必须重复验证。

### 2. 持久化任务后再返回

要保证任务可恢复，Provider 必须存在持久化任务事实。优先复用现有后端的真实任务/队列实体；如果当前没有任何可表示达人拓展任务的实体，则新增最小 `manual_sourcing_tasks` 业务表，而不是把聊天状态当任务表。

最小任务事实包括：

- `task_id`；
- `requirement_id`；
- `inquiry_id`；
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

如果 Provider 只能同步执行达人拓展，则必须在响应前完成真实采集和入池；此时返回 `completed`。没有持久任务也没有同步结果时，不能实现“保证启动”。

### 3. 执行、硬筛和入池

执行器从权威需求生成搜索上下文：

1. 按平台和 `field_match_mapping` 编译与 `search_creators` 相同的硬条件；
2. 从批准的达人拓展来源获取候选；
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

达人拓展结果完成后，应刷新当前需求的候选供给统计。可以由执行器在同一事务边界更新供给快照，也可以由后续明确的新一代 `search_creators` 重新计算；不得继续展示启动前的 6/5 和高风险结论。

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

启动或调整达人拓展时均设置 `next_action = rank_mcns`；仅 MCN 分支同样进入 `rank_mcns`，但不保留 `pending_manual_target_count`。

### `rank_mcns` 成功后

不得设置 `write_mcn_recommendation_items=false`；必须从实际持久化成功响应取得唯一非空 `inquiry_id`。存在 `pending_manual_target_count` 时保存询价证据并设置：

```text
next_action = manual_source_creators
waiting_for = null
```

没有待执行达人拓展时直接进入 `confirm_mcn_selection`。缺失 `inquiry_id` 时进入 `recover_rank_mcns`，不得调用达人拓展。

### `manual_source_creators` 成功后

只有输出满足固定 Schema 且包含真实任务证据，才设置：

```text
manual_sourcing_status = returned status
manual_sourcing_inquiry_id = matching returned inquiry_id
next_action = confirm_mcn_selection
waiting_for = user
```

失败时保持当前阶段并设置 `recover_manual_source_creators`；结果未知时只允许状态对账，不重放启动命令。

## 用户展示

启动成功后只展示业务事实，不展示内部 ID：

```markdown
### 达人拓展任务已启动
- 目标新增达人：4 位
- 当前状态：已启动
- 下一步：确认 MCN排序方案；达人拓展结果入池后重新评估供给风险
```

任务复用时展示“已存在进行中的达人拓展任务，本次沿用”，不能声称又启动了一次。

失败时展示真实安全错误码和恢复选项，不能把本地 `next_action` 当成远程成功。

## 询价外发边界

达人拓展供给确认只授权达人拓展和 MCN排序，不授权 `create_with_distributions`。完整顺序保持：

```text
供给确认
→ MCN排序并生成 inquiry_id
→ 达人拓展启动（可选，关联同一 inquiry_id）
→ MCN 选择
→ 询价字段选择
→ create_with_distributions 本地预检
→ 独立“企微外发确认”
→ 同参数正式外发
```

任何“确认后开始 MCN排序并重发询价”的合并文案都应删除。

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
| 任务执行中部分结果入池 | `running` + `accepted_count` | 保留任务，进入 MCN 确认 |
| 来源耗尽但未达到目标 | `completed` + 缺口原因 | 展示实际结果和剩余风险 |

## 修改范围与实施顺序

正式实施按以下顺序进行：

1. **Spec**
   - 修改 `spec/mcp.json` 中 `rank_mcns.inquiry_id` 证据及 `manual_source_creators` 输入和固定输出 Schema；
   - 修改 `spec/workflow.json` 的供给确认、先 rank 后达人拓展和后续 MCN 确认转移；
   - 补充错误码、状态字段和必要的数据库任务实体契约；
   - 更新 Spec hash 和生成引用。
2. **Provider / Database**
   - 让 `rank_mcns` 原子创建/解析当前需求的询价关联并返回 `inquiry_id`；
   - 实现两字段 handler、事务校验、任务持久化、幂等与执行器；
   - 实现硬筛、去重、入池、状态恢复和真实响应；
   - 如无现成任务实体，再实施经过批准的最小 migration。
3. **Hook / Skill**
   - 解析供给风险与补量；
   - 增加三项供给命令映射和调整数量流程；
   - 将供给命令先映射到 `rank_mcns`，收到 `inquiry_id` 后再映射到达人拓展；
   - 将达人拓展成功后的 `next_action` 改为 `confirm_mcn_selection`；
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
5. `rank_mcns` 成功输出缺 `inquiry_id` 时契约测试失败；
6. 达人拓展成功输出缺 `task_id/inquiry_id/status/target_count` 时契约测试失败。

### Hook 回放

1. 高风险 6/5、建议 4，选择“启动达人拓展并开始MCN排序”后，记录 `next_action=rank_mcns` 和目标 4；
2. `rank_mcns` 返回真实 `inquiry_id` 后才转 `manual_source_creators`；缺失时进入恢复且不调用达人拓展；
3. 随后的达人拓展 Tool 参数严格为 `{requirement_id,target_count}`，不擅自加入 `inquiry_id`；
4. 真实 `started` 且回显相同 `inquiry_id` 后转 `confirm_mcn_selection`；
5. `success=true` 但无询价或任务证据时进入恢复，不得显示已启动；
6. “仅开始MCN排序”不调用达人拓展；
7. “调整达人拓展数量”保留用户确认的正整数，并仍先执行 `rank_mcns`；
8. 取消、关闭和超时不调用 Tool；
9. 达人拓展成功不会进入 `create_with_distributions`。

### Provider / Database

1. 同幂等键、同参数并发两次只创建一个任务并返回同一 `task_id`；
2. 同幂等键改 `target_count` 返回冲突；
3. Provider 在任务创建前重新计算供给，陈旧计划不启动；
4. 任务可从新会话通过 `get_workflow_state` 恢复；
5. 同一达人跨达人拓展来源和 MCN 去重，但来源记录都保留；
6. 硬筛失败达人不进入候选池；
7. 队列投递未知时不重复投递；
8. 完成数小于目标时返回真实缺口原因；
9. `rank_mcns` 为同一需求原子创建/复用唯一询价关联并稳定返回同一 `inquiry_id`；达人拓展任务外键关联该询价。

### Live E2E

隔离测试需求固定覆盖：

```text
需求 5 → 搜索命中 6 → Provider 判高风险 → 建议达人拓展 4
→ 用户确认启动达人拓展并开始 MCN排序
→ rank_mcns
→ 返回真实 inquiry_id
→ manual_source_creators(requirement_id,4)
→ 返回相同 inquiry_id + 真实 task_id/status=started
→ MCN 确认
→ 达人拓展结果入池并刷新供给
→ 单独企微外发确认
```

同时核对数据库任务行、ledger、候选池、offer、平台达人记录、Hook 状态和 Provider trace。任何一层没有真实启动证据，E2E 失败。

## 最终验收标准

以下条件全部满足，才可宣称“高风险供给能够启动达人拓展”：

1. Tool 公开输入只有 `requirement_id` 和 `target_count`；
2. 高风险供给弹窗明确提供启动达人拓展选项，并显示确认数量；
3. 用户提交后同轮先产生真实 `rank_mcns` Tool call；
4. Provider 为同一需求持久化询价关联并返回真实 `inquiry_id`，随后才产生 `manual_source_creators` Tool call；
5. Provider 持久化关联该询价的唯一任务并返回相同 `inquiry_id`、真实 `task_id` 与允许状态；
6. 重复调用不产生重复任务，未知结果不盲重试；
7. Hook 只在远程询价与任务证据完整且匹配时显示启动成功；
8. 达人拓展成功后进入 MCN 确认，不重复 `rank_mcns`，也不跳过 MCN 流程；
9. 供给确认不授权企微外发；
10. 达人拓展结果经过同一套硬筛、去重和 provenance 规则后入池；
11. Contract、Hook、Provider、Database 和隔离 Live E2E 全部通过。

## 回滚

- Provider 保留旧一字段调用兼容只能用于灰度读取，不能在正式插件继续发送；正式切换后缺 `target_count` 必须拒绝，避免再次出现隐式补量。
- 关闭达人拓展启动 feature flag 后，供给弹窗退回“仅开始 MCN排序”，不得继续展示可启动达人拓展。
- 回滚插件时不删除已经创建的任务或候选；任务按真实状态完成、取消或人工处理。
- 数据库 migration 如存在，只回滚未使用的结构，不删除审计、任务或已入池业务事实。
