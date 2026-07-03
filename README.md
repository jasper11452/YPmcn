# YPmcn

MCN 达人筛选、询价、排序与提报的本地 MCP 服务。当前阶段以 MySQL
`d-oa-test.eshypdata.com:3306/ypmcn` 为事实源；数据库密码只读取
`YP_DATA_PASSWORD`。

## 当前能力

- 12 个 Agent MCP 工具：9 个写工具、2 个业务只读工具、1 个状态只读工具。
- `create_mcn_inquiries` 是后端内部服务，只写询价、标准文案和 outbox，不暴露给 Agent。
- 显式 Pydantic 输入 Schema；统一响应、字符串 ID、分/比例/百分制/RFC 3339 单位契约。
- 宿主 Agent 结构化需求 + 服务端证据、阻断字段、规则白名单和版本指纹校验。
- MySQL Unit of Work、数据库幂等账本、工作流锁、Gate、运行快照和审阅证据。
- 确定性达人评分 v1、固定 MCN 权重、硬筛、报价时效和供给风险计算。
- checksum + MySQL advisory lock 增量迁移；旧 PostgreSQL/pgvector 脚手架已移除。

## 本地开发

```bash
uv sync --all-groups --locked
uv run pytest -q
uv run ruff check .
```

Docker MySQL 集成测试（容器端口示例为 `33306`）：

```bash
YP_TEST_MYSQL_PORT=33306 uv run pytest tests/integration/test_mysql_persistence.py -q
```

## 数据库配置与迁移

默认要求 TLS。当前测试 RDS 不支持 TLS，只允许同时设置以下两个变量时明文连接，服务会输出警告：

```bash
export YP_DATA_ENV=test
export YP_DATA_SSL_MODE=disabled
export YP_DATA_PASSWORD='...'
```

迁移 dry-run 默认只读；应用迁移必须显式传 `--apply`：

```bash
uv run python scripts/migrate_db.py
uv run python scripts/migrate_db.py --apply
```

## 启动 MCP

默认使用本地 `stdio`：

```bash
uv run python apps/mcp-server/main.py
```

Streamable HTTP 仅作为本地调试入口：

```bash
YP_MCP_TRANSPORT=streamable-http uv run python apps/mcp-server/main.py
```

默认地址为 `http://127.0.0.1:8000/mcp`。

## 需求校验调用约定

`validate_requirement` 不依赖 MCP Sampling。调用方需要同时提交客户原文
`raw_messages` 和结构化的 `parsed_requirement`：

- 金额统一使用分，返点使用 `0-1`，平台使用 `xhs` 或 `dy`。
- `field_evidence` 中的每段证据必须原样出现在 `raw_messages` 中。
- 缺失的阻断字段保持为空，不允许宿主模型自行补全。
- 服务端负责确定性规则校验、需求指纹、版本管理、幂等和落库。

因此 Codex、WorkBuddy 或其他不支持 Sampling 的 MCP Client 均可直接调用该工具。

## 目录

- `apps/mcp-server/application`：12 个工具和内部询价服务的事务编排。
- `apps/mcp-server/domain`：需求、硬筛、供给和确定性评分规则。
- `apps/mcp-server/persistence`：连接、Unit of Work、ledger 和迁移 runner。
- `db/migrations`：基于现有 MySQL 业务表的增量迁移。
- `tests`：契约、领域、持久化和 Docker MySQL 测试。

WorkBuddy Skill、hooks、企微 outbox worker 和启动脚本迁移属于下一阶段。
