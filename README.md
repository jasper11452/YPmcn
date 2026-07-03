# YPmcn

MCN 达人筛选、询价、排序与提报的 Agent 平台骨架。

## 当前能力

- 13 个稳定命名的 MCP 工具入口
- 统一响应契约、错误码与幂等控制
- 可验证的工作流状态机和人工审批 Gate
- 达人/MCN 评分、风险惩罚、供给评估与排序策略
- PostgreSQL + pgvector 数据迁移骨架
- 企业微信与管理后台的安全集成边界

未配置业务处理器时，MCP 工具会返回 `NOT_CONFIGURED`，不会伪造成功写入。

## 本地开发

```bash
uv sync --all-groups
uv run pytest -q
uv run ruff check .
```

启动 MCP Streamable HTTP 服务：

```bash
uv run python apps/mcp-server/main.py
```

默认地址为 `http://127.0.0.1:8000/mcp`。

## 目录

- `apps/mcp-server`：MCP 协议层与 13 个工具
- `apps/workflow-engine`：状态机与人工审批 Gate
- `apps/algorithm-engine`：筛选、评分与排序
- `apps/wecom-integration`：企业微信适配端口
- `apps/admin-console`：人工操作界面路由占位
- `db`：PostgreSQL 迁移和种子数据
- `shared`：跨服务数据契约
