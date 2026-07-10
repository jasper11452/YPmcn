# YPmcn 契约优先自动化重构设计

**状态：** 已批准执行  
**日期：** 2026-07-11  
**目标版本：** `3.0.0`

## 1. 结论

采用“安全止血 + 契约优先 + 双档位识别 + 本地参考 MCP + 单一验证入口”。

仓库内的批准 Spec 是目标行为唯一来源；运行时 `inputSchema` 是部署兼容性证据。两者不一致时，Agent 和 Hook 必须返回 `integration_required`，不得把目标链路静默降级到旧链路，也不得猜参数。

当前仓库负责：

- OpenClaw Skill、Hooks 和会话级状态投影。
- 目标/旧版 MCP 契约、错误码、状态机和数据库边界 Spec。
- 无网络、无真实数据库、无企微副作用的本地参考 MCP。
- 远端 `tools/list` 契约检查、测试、打包、secret scan 和 CI。
- 向量 MCP 的可靠性基线。

当前仓库不冒充负责：

- 生产数据库迁移执行。
- 生产 provider 的幂等发送、回填行 ID 和事务实现。
- 外部密钥轮换和生产部署。

生产后端未满足目标 Spec 时，本地开发和 CI 可以通过，但生产就绪检查必须失败。

## 2. 已验证的基线

- `main` 有 5 个用户未提交的 macOS Alias 变更，重构不得触碰。
- 插件 Node 测试 48/48 通过，但锁定的是旧流程。
- 向量测试 13/13 通过，但来自无对应源码的 tracked `dist` 测试。
- 仓库契约测试 26 项中 6 fail、1 error。
- 线上 SSE 当前仍是旧契约：缺 `select_inquiry_form_fields`、`sync_mcn_inquiry_status`、`create_with_distributions`，并继续要求 `demand_id + demand_version`。
- 历史 MCP 实现早于目标契约，虽然大部分测试通过，但仍直接写旧候选池/询价表，不能迁入作为生产基线。
- 源码、历史和旧 tgz 出现真实格式凭据；开发态插件默认拉起无鉴权写服务。

## 3. 方案比较

### 方案 A：补丁式安全收口

只修文档、单体 Hook 和版本。成本最低，但继续依赖多份手写契约，无法防止下一次漂移。

### 方案 B：契约优先控制面（采用）

机器可读 Spec 驱动 Hook、参考 MCP、文档断言和 provider checker；旧线上 profile 只用于识别，不允许自动降级。生产未升级时 fail-closed，本地仍可完整演练。

### 方案 C：全栈 v2 sidecar

接管数据库迁移、provider、调度、幂等和部署。当前缺生产后端代码、回填查询接口和外部权限，且与“不新增幂等/outbox 表”的限制冲突，本轮不实施。

## 4. 目标目录与职责

```text
YPmcn/
├── spec/
│   ├── profiles/
│   │   ├── legacy-1.9.4.json
│   │   └── mvp-v2.json
│   ├── database.json
│   ├── errors.json
│   └── workflow.json
├── src/
│   ├── contract/
│   │   ├── loader.ts
│   │   └── validator.ts
│   ├── hooks/
│   │   ├── guards.ts
│   │   ├── results.ts
│   │   ├── runtime-state.ts
│   │   └── register.ts
│   └── index.ts
├── skills/media-assistant/
└── tests/

reference-mcp/
├── server.mjs
└── state.mjs

scripts/
├── check-provider-contract.mjs
├── scan-secrets.mjs
└── verify.mjs
```

文件保持单一职责：Spec 描述目标，validator 做确定性校验，guards 决定调用前放行，results 解析结果，runtime-state 只保存可丢失的会话投影，register 只适配 OpenClaw 事件。

## 5. 契约权威与运行档位

### 5.1 `mvp-v2`

这是唯一可写目标档位。主链路固定为：

```text
validate_requirement
-> search_creators(requirement_id)
-> rank_mcns(candidate_pool_id)
-> 人工确认供需/MCN/消息
-> select_inquiry_form_fields(mcn_recommendation_id)
-> create_with_distributions
-> sync_mcn_inquiry_status
-> wait
-> sync_mcn_inquiry_status
-> ingest_mcn_submissions
-> sync_mcn_inquiry_status
-> rank_creators
-> create_submission_batch
-> record_client_feedback
```

`requirement_id` 只允许 `customer_demands.id`。`demand_id`、`demand_version` 和需求正文不得进入下游链路。

### 5.2 `legacy-1.9.4`

只保存已观测的线上工具名、必填字段和 schema hash，用于识别漂移和生成迁移报告。Skill 不自动进入此档位；任何 v2 请求都不得回退到旧 `demand_id + demand_version` 链路。

### 5.3 兼容判定

provider checker 对 `tools/list` 做以下判定：

1. 目标必需工具全部存在。
2. required、字段类型和禁止字段与 Spec 兼容。
3. schema hash 在一次会话/发布中固定。
4. 不兼容输出 `FAIL + missing_tools + schema_diffs`，退出码非零。

## 6. 状态与恢复

### 6.1 会话投影

Hook 只缓存：

```json
{
  "phase": "requirement_draft|requirement_ready|candidate_pool_ready|mcn_planning|field_selection_ready|distribution_sync_pending|waiting_return|recovering|recovery_sync_pending|recovered|recommendation_ready|submission_batch_ready|feedback_routing|blocked",
  "requirement_id": null,
  "candidate_pool_id": null,
  "mcn_recommendation_id": null,
  "inquiry_batch_id": null,
  "inquiry_ids": [],
  "run_id": null,
  "batch_no": null,
  "field_selection": null,
  "last_sync": null,
  "manual_recovery_confirmed_at": null
}
```

投影可随进程重启丢失，不作为业务真相。重启后：

- 字段选择后、发送前丢失：必须重新选择，不能重建假快照。
- 发送后、首次 sync 前丢失：允许用 `mcn_recommendation_id + requirement_id` 做幂等 sync 对账。
- ingest 前必须在当前进程/会话先得到一次成功 sync。
- rank 前必须有最新 sync 返回 `recovered`。

### 6.2 强制状态顺序

- send 成功只进入 `distribution_sync_pending`，不得直接进入等待。
- 首次 sync 成功才进入 `waiting_return`。
- 普通 `message_received` 不清等待态。
- 手动回收只接受明确“继续回收/现在回收/提前回收”或结构化确认。
- scheduled ingest 只允许 `ctx.trigger=cron`。
- ingest 成功只进入 `recovery_sync_pending`；最终 sync 收口后才允许 rank。
- `recovered/closed` 重复回收在 Hook 层 no-op/阻断副作用。

## 7. 写操作与安全门禁

### 7.1 企微发送

缺任一项必须阻断：

- `sessionKey`、`toolCallId`、已知 operator role。
- 供需确认、目标 MCN 确认、消息确认。
- 当前会话的合法字段选择结果。
- `selected_count === items.length > 0`。
- `fields/items` 同 key 定义一致。
- `columns` 与有序 `items` 完全一致。
- 未来、带时区的 deadline/remindAt。
- 非空 supplier ID。
- `usageScope=project`。

目标 v2 不再执行旧 preview 两步；字段网页选择是最后确认点。`preview_only=true` 在 v2 被拒绝。

### 7.2 结果与日志

- 普通 MCP 结果必须是 `{success,data,error}`；错误为 `{code,message,retryable,details?}`。
- `select_inquiry_form_fields` 是唯一顶层字段结果例外。
- 不因缺 `trace_id` 失败。
- 不输出客户 Brief、完整 JSON、凭据或内部状态到日志。
- 写结果未知时不重复写；只走明确的查询/sync 恢复路径。

### 7.3 错误码

至少固化：`INTEGRATION_REQUIRED`、`SCHEMA_MISMATCH`、`INVALID_INPUT`、`INVALID_PHASE`、`CONFIRMATION_REQUIRED`、`FIELD_SELECTION_INVALID`、`PROVIDER_REFERENCE_MISSING`、`RECOVERY_NOT_CONFIRMED`、`RECOVERY_ALREADY_TERMINAL`、`STATE_CONFLICT`、`WRITE_RESULT_UNKNOWN`。

## 8. 数据库和 provider 必须满足的外部契约

这些约束进入 Spec 和生产就绪检查，但本仓库不伪造迁移执行：

- `mcn_agencies.supplier_id` 提供唯一 `mcn_id -> supplier_id` 映射。
- 一个 `mcn_recommendation_id + requirement_id` 在 MVP 只对应一个发送上下文；重发必须产生新的 `mcn_recommendation_id`。
- provider 使用稳定业务相关键实现发送对账；超时后可查询，不重发。
- 首次 sync 在事务中创建/复用一个快照、一个 inquiry batch、每 supplier 一个 inquiry 和一个 cron。
- `provider_distribution_id`、非空 token/fill_link 唯一。
- 回填用 `provider_distribution_id + provider_row_id` 幂等 upsert。
- 回收抢占使用数据库 CAS/行锁；手动与定时并发最多一个执行者进入 ingest。
- 三路同一达人合并优先级为 `mcn_submission > manual_source > candidate_pool`；自动精排只接收 `accepted`，`need_review` 必须人工处理。
- 同一 run 重试 `create_submission_batch` 返回当前未完成批次；只有反馈路由明确 `continue_submission` 后才创建下一批。

未满足任一项，生产就绪状态为 `BLOCKED`。

## 9. 本地参考 MCP

参考 MCP：

- 只用内存 repository、固定时钟和确定性 ID。
- 默认禁止网络、MySQL 和企微调用。
- 实现目标工具的 schema 和状态流，所有结果带 `simulated=true`。
- 覆盖字段选择、发送、首次 sync、手动/定时回收、重复 no-op、精排和提报。
- 不允许模拟结果被当作生产成功证据。

旧 DB-backed mock 保留为显式 legacy harness 或移出默认入口；插件启动绝不自动 fork 它。

## 10. 向量 MCP 可靠性

本轮只做有直接证据的可靠性修复：

- 删除当前源码和发布内容中的硬编码凭据。
- 恢复源码测试，构建前清理 generated `dist`，不再运行 orphan 测试。
- real 初始化使用单例 Promise，避免并发重复全库同步。
- embedding/rerank 增加 timeout、有限重试和批量上限。
- geo 过滤使用局部候选，不修改共享 singleton。
- 文件持久化改临时文件 + 原子 rename；损坏时显式 health failure。
- health 缺 API/DB/有效索引时返回失败，不再 `success=true`。

## 11. 自动化与发布

根 `npm run verify` 必须顺序执行：

1. package/spec/version consistency。
2. TypeScript build/typecheck。
3. Hook/state/contract unit tests。
4. 本地 reference MCP 场景测试。
5. 向量测试。
6. `uv run --no-project python -B -m unittest` 仓库契约测试。
7. secret scan。
8. clean build 后 `npm pack --dry-run` 内容检查。

`npm run verify:provider` 只做远端 initialize/tools-list 和 schema 比较，绝不调用写工具。CI 执行离线 `verify`；生产 canary 单独定时执行 `verify:provider`。

发布包必须：

- 只包含构建产物、Skill、Spec、必要向量 MCP 构建产物和 manifest。
- 不包含 mock、测试、源码、凭据、绝对路径或陈旧 dist。
- 四处版本元数据一致。

## 12. 验收标准

- 现有 5 个用户 Alias 改动内容和状态保持不变。
- 默认启动不会创建本地 HTTP 写服务。
- secret scan 对 tracked files 和新 pack 结果均为零命中。
- 目标链式 ID、字段选择和 `sync -> ingest -> sync` 均有 RED/GREEN 测试。
- send 成功但首次 sync 失败时，rank 和“已进入等待”表述都被阻断。
- 普通新消息不能解除等待；manual/cron 触发被区分。
- Hook 单体文件拆分为可独立测试的模块。
- `npm run verify` 在干净依赖环境退出 0。
- 当前线上 provider 检查明确退出非零，并报告三个缺失工具及旧 ID schema；不得显示为生产就绪。
- 新 tgz 通过内容与 secret scan，且不包含 legacy mock。

## 13. 风险与回滚

- v3 是公开工具参数和状态行为的破坏性升级，版本升为 3.0.0。
- 生产后端未升级前，新链路保持关闭；旧 profile 只读识别，不自动降级。
- Hook 回滚只需安装上一安全包；不得回滚到含凭据或默认 mock 自启动的包。
- 数据库/provider 迁移由独立 Change Proposal 执行，必须先通过这里的 provider contract 与并发验收。

