# AGENTS.md

## 权威与范围

- 工具参数唯一权威：`YPmcn/spec/profiles/mvp-v2.json`。
- 阶段和恢复唯一权威：`YPmcn/spec/workflow.json`。
- 数据库写归属：`YPmcn/spec/database.json`；不得由 Hook 或 Skill 虚构部署完成。
- 错误和重试：`YPmcn/spec/errors.json`；任何写结果未知都先对账，不盲目重写。

## 执行规则

- 下游只使用 `requirement_id`、`candidate_pool_id`、`mcn_recommendation_id`、`run_id` 等明确语义 ID。
- provider 工具/schema 与 mvp-v2 不一致时返回 `integration_required`，不降级旧契约。
- reference-mcp 仅离线模拟；`simulated=true` 永远不是生产证据。
- 生产 provider 检查只允许 initialize、initialized notification、tools/list，不调用写工具。
- Python 命令始终使用 `uv`，禁止 pip。

## 验证入口

- 仓库离线验收：`npm run verify`。
- 生产 provider 独立门禁：`npm run verify:provider`。
- 生产门禁失败不得通过降低 schema 检查强度来消除。

## 变更要求

- 先写失败测试，再做最小实现。
- 不记录 Brief、完整 payload、凭据或内部状态。
- 不编辑生成的 `dist/` 作为源码；先改 source，再构建验证。

