# YPmcn contract-first automation

本仓库把 2026-07-09 的四份业务文档固化为可验证的 `mvp-v2` 契约、OpenClaw Hook、无网络 reference MCP 和只读 provider 预检。

## 当前结论

- 仓库目标：`mvp-v2`，语义 ID、字段选择、发送门禁、`sync → ingest → sync` 恢复链均已固化。
- 当前生产 provider：检测为 `legacy-1.9.4`，不是 v2。
- 明确缺口：`select_inquiry_form_fields`、`create_with_distributions`、`sync_mcn_inquiry_status`。
- 处理原则：返回 `integration_required`，不自动切换旧参数、不把模拟结果当作生产证据。

## 目录

- `YPmcn/spec/`：工具、工作流、数据库边界、错误语义的机器权威。
- `YPmcn/src/hooks/`：fail-closed 会话门禁与可丢失状态投影。
- `YPmcn/skills/media-assistant/`：Agent 路由和人工操作文档。
- `reference-mcp/`：完全离线、结果带 `simulated=true` 的 v2 演练服务。
- `vector-mcp/`：创作者向量检索服务。
- `scripts/check-provider-contract.mjs`：只执行 MCP 初始化与 `tools/list` 的生产兼容性检查。

## 验证

```bash
cd YPmcn && npm test
node --test tests/reference_mcp.test.mjs tests/provider_contract.test.mjs
PYTHONDONTWRITEBYTECODE=1 uv run --no-project python -B -m unittest -v tests/test_skill_package.py
node scripts/check-provider-contract.mjs --url https://mcp.eshypdata.com/sse
```

生产预检当前应以非零退出，并报告上述三个缺失工具。该失败是上线门禁，不是仓库离线测试失败。统一入口将在 `npm run verify` 与独立的 `npm run verify:provider` 中维护。

## 安全边界

插件不内置 provider 凭据，不自动启动根目录开发服务，不记录客户 Brief 或 payload。reference MCP 不访问网络、不写生产数据库、不发送企微。
