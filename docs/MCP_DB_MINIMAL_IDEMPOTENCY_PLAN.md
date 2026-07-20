# MCP + 数据库最小幂等与状态修正方案

## 结论

最小方案先只改服务端中间层：所有 MCP 写 Tool 复用现有 `mcp_tool_call_ledger`；本地数据库写与 ledger 同事务；`create_with_distributions` 把同一个幂等键传给外部 API；`sync_mcn_inquiry_status` 直接读取同库发送方权威状态并 upsert 现有 `mcn_inquiries`。不新建 workflow 大表，也不预先改业务表；只有外部 API 明确不消费幂等键时，才给其项目表补一个请求标识。

当前独立后端工作树已完成“不改表”部分：10 个本地写入口和外部创建入口共 11 个写入口接入 ledger；本地业务写与 ledger 终态同事务；外部创建转发稳定 `Idempotency-Key`，网络未知结果持久化为 `unknown`；sync 读取 `core_project/core_distribution/core_notificationlog` 并按已推荐 MCN 的 `mcn_recommendation_id + attempt_no` upsert inquiry；`get_workflow_state` 可按需求身份或 trace 聚合。上述内容已通过本地测试和真实库只读 ORM 校验，但尚未部署到远程开发机。

## 2026-07-18 真实开发库证据

本方案已从当前机器直连 `ypmcn` MySQL 8.0.36 只读核对，不基于 Mock：

- `mcp_tool_call_ledger` 已存在且当前 0 行；`idempotency_key`、`trace_id` 各有唯一索引；另有 `tool_name`、`parent_type/parent_id`、`request_summary_json`、`response_summary_json`、`status`、开始/结束时间。
- ledger 的 `demand_id` 是 bigint，与当前 `customer_demands.demandId varchar(255)` / `id char(32)` 不一致；实现已保持该列为 NULL，统一用 `parent_type='requirement' + parent_id=<customer_demands.id>`。
- `core_project` 当前 50 行，没有客户端请求标识；`core_distribution` 当前 61 行，`(project_id,supplier_id)` 已唯一，并有 `status`、`row_count`、`last_saved_at`、`submitted_at`、`distributed_at`。
- `mcn_inquiries`、`mcn_inquiry_status_syncs`、`mcn_submission_items` 当前均 0 行，尚无真实回收链证据。
- `customer_demands` 当前 0 行；只有主键、`demandId` 普通索引和 `status` 普通索引，没有 `(demandId,demandVersion)` 唯一约束。

## 1. 现有 ledger 直接承担 11 个写 Tool 幂等

不新增 ledger 列。统一约定：

```text
idempotency_key = v1:<tool_name>:<client_operation_id>
request_hash    = sha256(canonical_json(actual_arguments))
```

`client_operation_id` 由 YP Action/MCP 调用中间层在一次业务意图开始时生成，通过请求 metadata 传递，并在同一次自动网络重试、结果对账时复用；不让用户或 Agent 填写，也不能使用会在重新调用时变化的 JSON-RPC request id。若当前 Gateway 已有稳定的 tool-call operation ID，直接复用，不给 11 个 Tool 各加一个业务参数。`request_hash` 放进 `request_summary_json.request_hash`；响应资源 ID 放进 `response_summary_json.resources`。状态只用 `in_progress/succeeded/failed/unknown`。

服务端统一包装器规则：

1. 原子 INSERT ledger；唯一键冲突后读取原行。
2. 同 key、同 hash、`succeeded`：直接返回原资源，不再执行 handler。
3. 同 key、不同 hash：返回 `IDEMPOTENCY_CONFLICT`。
4. `in_progress`：返回处理中，不并发执行。
5. `unknown`：只返回对账动作，禁止重放。
6. 只有确认事务未提交的失败才是 `failed`。

`validate_requirement` 首次还没有需求 ID，因此先以 `parent_type='brief_intake'`、`parent_id=client_operation_id` 认领；成功后同事务把 parent 改为 `customer_demand/<id>` 并在响应摘要保存 `demandId/demandVersion`。其余写 Tool 使用当前业务主键和快照/批次 ID 组成稳定 operation identity。

本地 MySQL 写必须把“业务写 + ledger succeeded/响应摘要”放在同一事务。commit 响应丢失时先查 ledger；不得再次执行 handler。

## 2. 外部 create-with-distributions 的最小边界

现有文档确认 `POST /api/projects/create-with-distributions/` 会在一个事务里创建项目与全部分发，重复供应商只会 skipped；但接口没有请求幂等键，所以“响应丢失后再次 POST”仍可能重复创建项目。

当前零迁移实现先把同一个稳定键放入外部请求 `Idempotency-Key`；HTTP 明确拒绝记 failed，连接超时或响应丢失记 unknown 且后续同 key 只返回对账要求，不再 POST。这能做到 fail-closed，但外部 API 文档未承诺消费该请求头，因此不能宣称跨系统 exactly-once。

若外部 API 后续确认不支持该请求头，完整 exactly-once 的最小数据库改动才是给 `core_project` 增加一个可空客户端请求 ID 和唯一索引，历史行不受影响：

```sql
ALTER TABLE core_project
  ADD COLUMN client_request_id varchar(255) NULL;

CREATE UNIQUE INDEX uq_core_project_client_request_id
  ON core_project (client_request_id);
```

最小 API 改动：`create-with-distributions` 接受 `clientRequestId/client_request_id`；MCP 固定传 ledger 的 `idempotency_key`。API 在创建事务内写 `core_project.client_request_id`：

- 新 key：正常创建并返回 project/distributions；
- 已有 key：API 直接返回原 project 和 distributions，HTTP 200，不再创建；同 key 不同 hash 已由 MCP ledger 在发出 HTTP 请求前拒绝；
- API commit 后连接中断：MCP 按 `client_request_id` 查询 `core_project`，再按 project ID 查询 `core_distribution`，补齐 ledger 为 succeeded；查不清才保持 unknown。

API 不需要读取 MCP ledger，也不需要新增第二张表；只需在原创建事务中按 `client_request_id` 先查后建，并依赖唯一索引处理并发。若当前外部 API 不能接受并持久化 `clientRequestId`，只能做到 at-most-once/fail-closed，不能宣称完整幂等。

## 3. 企微发送与回收直接读现有权威表

发送 API 的响应已有 project ID、distribution ID、supplier、token 和 status。MCP 成功后把这些安全资源引用写入 ledger 的响应摘要，不保存 API Key 或完整客户 Brief。

当前公开 Provider 输入为 `sync_mcn_inquiry_status({requirement_id, project_id, supplierIds})`；服务端再把 `supplierIds` 逐个解析为内部机构身份。其最小实现：

1. 用成功的 create ledger 证明 project 属于当前 requirement；
2. 对每个 `supplierId` 读取 `core_project` 和唯一 `(project_id,supplier_id)` 对应的 `core_distribution`；
3. 用 `mcn_recommendation_item_id + attempt_no` 现有唯一键 upsert `mcn_inquiries`，写发送时间、截止、状态、提交时间和行数；
4. 用 `(requirement_id,project_id,mcn_id)` 现有内部唯一键更新 `mcn_inquiry_status_syncs` 的最后同步时间；`mcn_id` 不是公开 Tool 参数；
5. 相同 distribution 状态重复同步汇总返回同一组正整数 `inquiry_ids`，不新增记录。

`core_distribution` 就是发送方数据库状态，不需要再建复制表。只有读取不到唯一 recommendation item、ledger 关联断裂或 distribution 不唯一时返回 `state_conflict/integration_required`，不得挑“最近一条”。

## 4. get_workflow_state 不建状态表

按需求主键或唯一的 `demandId+demandVersion` 聚合：

```text
customer_demands
→ creator_candidate_pool
→ mcn_recommendation_items
→ mcp_tool_call_ledger
→ core_project/core_distribution
→ mcn_inquiries/mcn_submission_items
→ recommendation_runs/creator_recommendation_items
→ submission_batches/creator_submissions
```

只根据已提交事实推导 phase 和 `allowed_actions`。关联断裂、多个版本、ledger `in_progress/unknown` 或状态互相冲突时清空写动作并返回唯一阻塞原因。这样跨 session 只需要需求身份，不依赖聊天记录或本地 Hook 状态。

## 5. 当前数据库最大问题与最小修正

按风险排序：

1. **外部 API 未承诺请求唯一键**：当前先转发 header 并对 unknown 禁止重发；API 若不消费该键，再执行上面的 `core_project.client_request_id` 单列迁移。
2. **线上 ledger 仍为空**：表不改；统一包装器已在本地源码接入，待部署后做并发/断线测试。
3. **线上回收实现未更新**：本地源码已实现从发送方三表同步，待部署后用真实 distribution 验证。
4. **跨域 ID 类型不统一**：ledger 的 `demand_id`、`submission_batches.demand_id` 是 bigint，而需求主键/业务 ID 是字符串。最小方案在新链路统一使用 ledger 的 `parent_type + parent_id` 和各业务表已有字符串键，不为此改动已经敲定的 `customer_demands`。

`customer_demands` 的字段、类型、Null 规则，以及 `field_match_mapping` 的 110 条已匹配映射均按业务方确认视为权威；本方案不修改这两张表，也不建议为了幂等新增它们的列或索引。

## 验收

- 同 key 并发两次只产生一份业务记录，并返回同一资源 ID；
- 同 key 改参数得到 `IDEMPOTENCY_CONFLICT`；
- 本地 commit 响应丢失可从 ledger 恢复；
- 外部 API 响应丢失后按 `client_request_id` 找回原 project，POST 只发生一次；
- 重复 sync 不新增 inquiry，状态与 `core_distribution` 一致；
- 新 session 只给需求身份即可恢复相同 phase、关键 ID 和唯一下一动作；
- 任一断链或 unknown 都 fail closed。
