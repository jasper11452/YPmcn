# CHG-2026-014 Impact Analysis

```yaml
task_id: CHG-2026-014
risk_level: medium
runtime_scope: local-only independent vector-mcp
business_runtime_impact: none
database_write_impact: none
```

## 影响

| 域 | 变更 | 边界 |
| --- | --- | --- |
| vector-mcp | 新增官方 Qdrant REST SDK adapter、DashScope、只读 MySQL、投影脱敏、同步与检索管线 | 仍是 excluded namespace，仅三个原有运维工具 |
| MySQL | 读取权威达人源 `dy_mz`、`xhs_mz` 与可选 `core_project.description` | 按平台固定 SELECT；凭据仅来自环境变量；不记录凭据或行 |
| Qdrant | 本地 collection；必填 `content`、可选 `commercial` named vectors；含 `commercial_vector_available` 的 provenance-only payload | 可重建派生索引，无业务写权限；缺失 commercial 不造零向量或复制向量 |
| 外部 Provider | 脱敏后调用 `text-embedding-v4` / `qwen3-rerank` | 默认测试注入 fake fetch，不消耗真实 API |
| Spec / 生产 MCP / workflow | 无变更 | 不接入或声称接入 `search_creators` / `rank_creators` |

## 风险与控制

- 源表漂移：两张权威源表使用各自固定字段 SELECT，缺表时显式返回 unavailable。
- 敏感文本外发：投影 allowlist + 调用前脱敏；Provider/Qdrant 错误不包含请求正文。
- 派生索引过时：搜索命中必须用当前 MySQL 行回源；缺行即丢弃。
- 旧索引覆盖不全：规则生效后执行一次全量 resync，补建 content-only 点并刷新 `commercial_vector_available`；仅增量同步无法修复此前被跳过的行。
- 缺失 commercial 的排序偏差：commercial 查询自然不返回该点，合并与 rerank 不把缺失值换算为 0 分或负信号；SQL-only provenance 明确为 `false`，不声称使用了 commercial vector。
- 硬条件被软分覆盖：回源后先执行硬过滤；缺少价格/合规权威字段时 fail closed。
- 依赖中断：仅允许显式 SQL-only 降级；无法产生 SQL 候选时返回稳定错误。
- 参数误升产：所有默认值仅服务 local test，未修改 Spec 或生产 runtime。

## 兼容与回滚

fake 模式仅保留为旧单元测试 fixture，real 模式不读取或写入 fake/local JSON。既有工具名和业务 namespace 排除规则不变。

回滚代码并删除本地 Qdrant 派生 collection 即可；没有 MySQL 数据、权限或迁移需要恢复。
