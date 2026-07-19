# 开发 MCP 现状、修复清单与联合调试

基线：开发与生产 Provider 统一使用 `https://mcp.eshypdata.com/sse`，正式契约要求 15 个业务工具，MySQL 数据库为 `ypmcn`。当前 endpoint 的写行为、幂等和恢复链仍需真实联调验证；Skill、Hook 和 Spec 不得把未验证源码写成线上能力。

## 当前问题与后果

### 1. 询价状态没有真正同步

远程已部署版本尚未复核。独立后端工作树现已读取 `core_project/core_distribution/core_notificationlog`，先验证机构属于当前需求与平台的 MCN 推荐，再按 `mcn_recommendation_item_id + attempt_no` 创建或更新 `mcn_inquiries`，并幂等更新 `mcn_inquiry_status_syncs`。重复 sync 单测保持同一 inquiry；外部显示 submitted 但行尚未 ingest 时，工作流停在 `returned_not_ingested`。

剩余验收：部署后用真实 project/supplier 执行首次 sync、回收、ingest、再次 sync，并在新 session 仅凭需求身份恢复；不能用本地单测替代。

### 2. 幂等账本没有启用

真实开发库的 `mcp_tool_call_ledger` 仍为 0 行，说明部署态尚未产生证据。独立后端工作树已把 10 个本地写入口和 1 个外部创建入口接入统一包装器：同 key/hash 重放原结果，不同 hash 冲突，本地失败回滚业务写，外部响应未知持久化为 unknown 并禁止重发。

剩余验收：MCP 中间层必须在同一业务意图及自动重试中转发稳定 `Idempotency-Key`；外部 API 还需明确持久化该键或提供按键查询。状态 sync 没有显式 key 时允许重新读取最新快照，因为其业务写本身按唯一键 upsert；这不能推广到其他写 Tool。

### 3. “审计”并未真正启用

`audit_manual_adjustment` 目前直接修改推荐 item 的 JSON、reason/status，没有 append-only 审计事件。后果是无法证明修改前值、修改人、时间、原因和关联调用，历史值可被覆盖，不能用于合规追责或可靠回滚。

修复：新增不可变 `audit_events`，至少记录 actor、toolCallId、entity、entity_id、before、after、reason、trace_id、created_at；业务更新与事件写入同一事务。读取历史只查事件，禁止 update/delete 审计行。

### 4. 需求范围必须在 Agent 调用前规范化

`customer_demands` 与 `field_match_mapping` 已确认是权威。Agent 调 `validate_requirement` 前，把范围字段统一为无空格字符串 `"[min,max]"`；上限条件例如“不超过 50%”写 `"[0,0.5]"`。内部单达人预算字段仍为 `kolOfficialPriceL1/L2/L3`，但用户侧只说小红书图文/视频或抖音对应时长，小红书不得使用第三档；项目总预算没有专用列，只在 `rawMessagesJson` 保留原文。

Skill 负责规范化自然语言范围，MCP/Provider 负责拒绝数组、倒序、比例大于 1、虚构字段和缺少报价档位的请求；Hook 不再重复校验 requirement payload。后端只按 `(platform,source_field_name,match_status='已匹配')` 拆成已确认的目标 Min/Max，Agent 不生成目标字段名。

### 5. 广告参数有名无实

- `get_creator_detail.include_vector_text`
- `get_creator_detail.include_recent_metrics`
- `get_recommendation_run_detail.include_creator_detail`
- `get_recommendation_run_detail.include_feedback`

当前实现未使用这些参数。Skill 已停止发送，但开发 MCP 的 `tools/list` 仍会广告。修复方式二选一：实现并增加返回测试，或从 input schema 删除；不要继续保留“看似可用”的参数。

### 6. 供应商返点事实源写错

`creator_supply_offers` 没有持久化价格/返点列；当前供应商返点事实源是 `core_supplier.default_rebate_rate`，通过 `creator_supply_offers.supplier_id` 关联。需求中的 `customer_demands.rebate` 只是客户原始要求，不能当作供应商实际返点。

## 逐工具数据库事实

| 工具 | 当前实际读写 |
|---|---|
| `validate_requirement` | 写 `customer_demands` |
| `search_creators` | 读需求、平台达人、offer、supplier；写 `creator_candidate_pool` |
| `rank_mcns` | 读需求/候选/offer/supplier；写 `mcn_recommendation_items`；返回 `mcn_run_id` |
| `select_inquiry_form_fields` | 本地网页/回调，不读写业务库 |
| `create_with_distributions` | 写外部项目 API，不写开发 MySQL |
| `sync_mcn_inquiry_status` | 本地待部署源码读发送方三表，upsert `mcn_inquiries` 与同步元数据 |
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

1. `npm run test:fast`：源码 Plugin/Hook/契约回归，验证非外发 Tool 放行、本地 JSON 状态转换与企微外发 AskUserQuestion 两阶段确认。
2. `npm run verify:provider`：直接对开发 SSE 做 `initialize + tools/list` 契约快照，发现工具/参数漂移。
3. Hook 响应回放：用脱敏外发参数验证 AskUserQuestion 输入指纹、外发请求指纹、参数变化及 unknown 后重新确认，不需要启动桌面端。
4. `npm run test:openclaw`：从源码加载 Plugin/Skill，使用隔离配置检查宿主装载。

联调建议新增服务端测试接口或脚本：用测试 demand 调 15 个工具中的只读工具和可回滚写工具；MySQL 写测试放事务后 rollback，外部写使用 sandbox/fake adapter。每次 MCP 修改自动导出 `tools/list` 和脱敏响应 fixture，仓库 CI 对比 Spec、Tool 文档与 Hook 回放。

发布候选才运行 `npm run pack:yp` 并在 YP Action/OpenClaw 做安装器冒烟，随后必须按《高效联调测试指南》用真实需求完成 Agent → MCP → 开发库 → 测试企微 → 回收 → CSV → 新 session 恢复的 Live E2E。当前包写入统一远程 SSE；只读契约检查不能替代远程写行为与 Live E2E。宿主对 bundle remote SSE 的自动注册仍需在干净 YP Action 安装环境验证。
