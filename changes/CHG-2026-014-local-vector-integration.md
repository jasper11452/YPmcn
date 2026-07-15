# CHG-2026-014：本地独立向量管线

```yaml
task_id: CHG-2026-014
status: IMPLEMENTED_LOCAL_TEST_ONLY
baseline: 619699b35da5ddc000711e24774883c8e55dbd83
scope: vector-mcp excluded namespace only
production_runtime_integration: false
```

## 结果

`vector-mcp` 的 real 模式现在是可独立运行的本地测试管线：只读 MySQL → 本地 Qdrant named vectors → MySQL 回源与硬过滤 → DashScope rerank。它不接入当前仓库中不存在的生产 `search_creators` / `rank_creators` runtime，也不声明生产参数已启用。

保留且仅保留三个既有运维工具：`sync_creator_tag_vectors`、`search_creator_tag_vectors`、`health_check_vector_store`。没有新增业务 MCP 工具、权限、后台调度器或数据库写入。

## 已验证的数据边界

- 可见抖音源：`mz_item_data_dy`。固定只读 SELECT 使用 `id`、`item_id`、`douyinId`、`update_time`、`kwUid`、`kwProvince`、`kwCity`、`followercount`、`date`、`data_json`。
- 项目查询源：`core_project.description`，按项目 id 单行读取。
- 未发现可确认的 XHS 源。`VECTOR_XHS_SOURCE_TABLE` 可配置；未配置或表不存在时返回明确 `source_unavailable`，不会伪造成功。
- 表名必须是安全标识符并属于固定/配置 allowlist。所有 SQL 均为固定 SELECT；无 DDL/DML。

## 本地配置

- MySQL：优先 `YP_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`，兼容原 `MYSQL_*`。
- Qdrant：使用官方 `@qdrant/js-client-rest`；`QDRANT_URL` 默认 `http://localhost:6333`，另有 `QDRANT_COLLECTION`、`QDRANT_VECTOR_SIZE`，可选 `QDRANT_API_KEY`。
- DashScope：`DASHSCOPE_API_KEY`；embedding 默认 `text-embedding-v4`。`qwen3-rerank` 还需要 `DASHSCOPE_WORKSPACE_ID`，或直接配置完整的 `DASHSCOPE_RERANK_BASE_URL`；模型和 endpoint 均可通过 `DASHSCOPE_*` 覆盖。
- `VECTOR_MCP_MODE=real` 才启用真实链路。默认测试不连接 MySQL、Qdrant 或 DashScope。

维度、collection、模型、超时、Provider 重试、候选数和 limit 都只是本地测试配置，不修改 Spec，不构成生产参数选择或激活。

## 数据与失败语义

- 每个点以 `platform + kwUid + source snapshot date` 生成确定性 UUID；同一达人同一天的更新覆盖原 point，不产生重复记录。
- Qdrant 每点同时保存 `content`、`commercial` named vectors。payload 只含 MySQL 回源身份、快照 provenance、模型与本地向量版本，不保存原文、向量分数或 rerank 分数。
- 外部请求前统一归一化并脱敏电话、邮箱、URL、身份证样式及长 ID token。身份、昵称、URL、机构、性别/年龄/地区、指标、价格/返点和 numeric-only JSON 不进入投影。
- Embedding、Qdrant 或 rerank 失败时，若固定只读 SQL 可产生候选，则返回显式 `retrieval_mode: sql-only`、`degraded_reason` 和 MySQL provenance；否则返回稳定 dependency error。禁止 fake vector 顶替 real 结果。

## 同步方式与回滚

首次不传 cursor 执行全量批次；后续人工传 cursor，固定使用 `update_time > cursor` 且按 `update_time, kwUid, id` 排序。没有后台 scheduler。

回滚：停止 real 模式，删除本地 Qdrant collection（派生索引），revert 本 Change 的 `vector-mcp` 与两份 CHG 文档。MySQL 无写入，无数据库回滚步骤。
