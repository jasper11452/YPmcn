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

- 达人权威源仅为 `dy_mz` 与 `xhs_mz`。两表均以 `kwUid` 为主键，使用 `update_time`、`date`、`description`、`kwProvince`、`kwCity`、`followercount` 及各平台固定语义字段的只读 SELECT；`kwUid` 同时作为回源行标识。
- 项目查询源：`core_project.description`，按项目 id 单行读取。
- 默认分别读取 `dy_mz` 与 `xhs_mz`；若源表不存在，返回明确 `source_unavailable`，不会伪造成功。
- 表名必须是安全标识符并属于固定/配置 allowlist。所有 SQL 均为固定 SELECT；无 DDL/DML。

## 本地配置

- MySQL：优先 `YP_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`，兼容原 `MYSQL_*`。
- Qdrant：使用官方 `@qdrant/js-client-rest`；`QDRANT_URL` 默认 `http://localhost:6333`，另有 `QDRANT_COLLECTION`、`QDRANT_VECTOR_SIZE`，可选 `QDRANT_API_KEY`。
- DashScope：`DASHSCOPE_API_KEY`；embedding 默认 `text-embedding-v4`。`qwen3-rerank` 还需要 `DASHSCOPE_WORKSPACE_ID`，或直接配置完整的 `DASHSCOPE_RERANK_BASE_URL`；模型和 endpoint 均可通过 `DASHSCOPE_*` 覆盖。
- `VECTOR_MCP_MODE=real` 才启用真实链路。默认测试不连接 MySQL、Qdrant 或 DashScope。

维度、collection、模型、超时、Provider 重试、候选数和 limit 都只是本地测试配置，不修改 Spec，不构成生产参数选择或激活。

## 数据与失败语义

- 每个点以 `platform + kwUid + source snapshot date` 生成确定性 UUID；同一达人同一天的更新覆盖原 point，不产生重复记录。
- 只有缺少 `contentText` 的行才跳过。每个已索引点必须保存 `content` named vector；仅当 `commercialText` 存在时才保存 `commercial` named vector。缺失值不会生成零向量，也不会复制 content 向量冒充 commercial。
- payload 以 `commercial_vector_available` 标记该点是否实际写入 commercial vector，并且只含 MySQL 回源身份、快照 provenance、模型与本地向量版本，不保存原文、向量分数或 rerank 分数。
- content 检索可覆盖所有已索引点；commercial 检索由 Qdrant 自然只返回带该 named vector 的点。合并按各列表最佳名次去重，缺失 commercial 不按 0 分或负信号处理；MySQL 回源后的结果 provenance 透传 payload 标记，SQL-only 明确标为 `false`。
- 外部请求前统一归一化并脱敏电话、邮箱、URL、身份证样式及长 ID token。身份、昵称、URL、机构、性别/年龄/地区、指标、价格/返点和 numeric-only JSON 不进入投影。
- Embedding、Qdrant 或 rerank 失败时，若固定只读 SQL 可产生候选，则返回显式 `retrieval_mode: sql-only`、`degraded_reason` 和 MySQL provenance；否则返回稳定 dependency error。禁止 fake vector 顶替 real 结果。

## 同步方式与回滚

首次不传 cursor 执行全量批次；后续人工传 cursor，固定使用 `update_time > cursor` 且按 `update_time, kwUid` 排序。没有后台 scheduler。

本规则上线后需要对现有本地 collection 执行一次全量 resync，以补建此前因缺少 commercial 文本而被跳过的 content-only 点，并写入新的可用性标记。

回滚：停止 real 模式，删除本地 Qdrant collection（派生索引），revert 本 Change 的 `vector-mcp` 与两份 CHG 文档。MySQL 无写入，无数据库回滚步骤。
