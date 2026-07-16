# 开发 MCP 现状、修复清单与联合调试

基线：开发 Provider `http://192.168.0.129:32008/sse`，15 个公开工具，MySQL 数据库 `ypmcn`。本文记录尚未在 MCP 服务端修复的问题；Skill、Hook 和 Spec 不得把目标能力写成当前能力。

## 当前问题与后果

### 1. 询价状态没有真正同步

`sync_mcn_inquiry_status` 当前只读写 `mcn_inquiry_status_syncs`，不访问供应商侧状态，也不创建或更新 `mcn_inquiries`。`create_with_distributions` 又只写外部项目 API，因此后续 `ingest_mcn_submissions` 找不到本地 inquiry，主链可能在回收前断开。

修复：以 `project_id + mcn_id` 查询外部项目和分发状态；在事务中 upsert `mcn_inquiries`，保存外部状态、最后同步时间、错误和来源版本；返回稳定的 `inquiry_id`、状态及是否可 ingest。重复调用按同一业务键幂等。

### 2. 幂等账本没有启用

`mcp_tool_call_ledger` 表存在但为 0 行，工具实现没有统一使用它。后果是未知结果后无法凭 `toolCallId` 对账，外部创建、批次创建和人工调整存在重复写风险，也无法统一追踪一次调用的最终结果。

修复：所有业务写在事务入口登记 `toolCallId + tool + business_key + request_hash`；成功保存响应摘要和资源 ID；相同 key/hash 返回原结果，不同 hash 冲突；外部调用采用 pending → succeeded/failed/unknown 状态，并提供 reconcile。

### 3. “审计”并未真正启用

`audit_manual_adjustment` 目前直接修改推荐 item 的 JSON、reason/status，没有 append-only 审计事件。后果是无法证明修改前值、修改人、时间、原因和关联调用，历史值可被覆盖，不能用于合规追责或可靠回滚。

修复：新增不可变 `audit_events`，至少记录 actor、toolCallId、entity、entity_id、before、after、reason、trace_id、created_at；业务更新与事件写入同一事务。读取历史只查事件，禁止 update/delete 审计行。

### 4. 需求预算语义被代理层错误转换

`budgetMinCents/budgetMaxCents/budgetRaw` 只表示项目总预算。用户说“单个达人预算/单人价格/达人报价”时，应写 `kolOfficialPriceL1/L2/L3`（人民币元），不能写 budget。未说明档位时必须让用户选择；抖音 L1/L2/L3 对应 1–20 秒、21–60 秒、60 秒以上。

当前代理层仍可能把达人价格区间归一到 budget，后果是搜索按总预算误筛、单位错位并污染需求记录。修复 `_normalize_validate_requirement_payload`：只有明确“项目总预算/整体预算”才生成 budget；单达人金额仅写已确认报价档位，区间在服务端提供正式范围字段前保留原文并返回待确认。

### 5. 广告参数有名无实

- `get_creator_detail.include_vector_text`
- `get_creator_detail.include_recent_metrics`
- `get_recommendation_run_detail.include_creator_detail`
- `get_recommendation_run_detail.include_feedback`

当前实现未使用这些参数。Skill 已停止发送，但开发 MCP 的 `tools/list` 仍会广告。修复方式二选一：实现并增加返回测试，或从 input schema 删除；不要继续保留“看似可用”的参数。

### 6. 供应商返点事实源写错

`creator_supply_offers` 没有持久化价格/返点列；当前供应商返点事实源是 `core_supplier.default_rebate_rate`，通过 `creator_supply_offers.supplier_id` 关联。需求中的 `rebateMinRate/rebateMaxRate` 只是筛选条件，不能当作供应商实际返点。

## 逐工具数据库事实

| 工具 | 当前实际读写 |
|---|---|
| `validate_requirement` | 写 `customer_demands` |
| `search_creators` | 读需求、平台达人、offer、supplier；写 `creator_candidate_pool` |
| `rank_mcns` | 读需求/候选/offer/supplier；写 `mcn_recommendation_items`；返回 `mcn_run_id` |
| `select_inquiry_form_fields` | 本地网页/回调，不读写业务库 |
| `create_with_distributions` | 写外部项目 API，不写开发 MySQL |
| `sync_mcn_inquiry_status` | 仅读写 `mcn_inquiry_status_syncs` |
| `ingest_mcn_submissions` | 读 inquiry/demand/supplier；写 submissions/offers/candidates/平台达人 |
| `manual_source_creators` | 写 candidates/offers/平台达人 |
| `rank_creators` | 读 candidates/offers/平台达人/MCN 推荐；写 runs/items |
| `create_submission_batch` | 读推荐/提报；写 batches/submissions |
| `record_client_feedback` | 写反馈相关提交/批次，必要时复制需求版本 |
| `get_recommendation_run_detail` | 读 run/items/submissions |
| `get_creator_detail` | 读平台达人/offers/supplier |
| `audit_manual_adjustment` | 修改推荐 item；当前无独立审计流水 |
| `get_workflow_state` | 跨多表浅层查询工作流事实 |

## 不打包的高效联合调试

日常开发固定走四层，只有发布候选才打包：

1. `npm run test:fast`：源码 Hook + 真实 stdio MCP 协议，先抓协议、字段和 phase 错误。
2. `npm run verify:provider`：直接对开发 SSE 做 `initialize + tools/list` 契约快照，发现工具/参数漂移。
3. Hook 响应回放：把脱敏后的真实工具响应作为测试 fixture 输入 `runtime-hooks`，验证 `mcn_run_id`、价格、返点、unknown outcome 和 phase，不需要启动桌面端。
4. `npm run test:openclaw`：从源码加载 Plugin/Skill，使用隔离配置检查宿主装载。

联调建议新增服务端测试接口或脚本：用测试 demand 调 15 个工具中的只读工具和可回滚写工具；MySQL 写测试放事务后 rollback，外部写使用 sandbox/fake adapter。每次 MCP 修改自动导出 `tools/list` 和脱敏响应 fixture，仓库 CI 对比 Spec、Tool 文档与 Hook 回放。

发布候选才运行 `npm run pack:yp` 并在 YP Action/OpenClaw 做一次安装器、配置同步和桌面交互冒烟。当前演示包明确写入开发 SSE，不代表生产地址已验收。
