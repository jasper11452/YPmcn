# 验收手册

## 离线仓库验收

```bash
cd YPmcn && npm test
node --test tests/reference_mcp.test.mjs tests/provider_contract.test.mjs
PYTHONDONTWRITEBYTECODE=1 uv run --no-project python -B -m unittest -v tests/test_skill_package.py
```

检查内容：machine specs、参数校验、Hook 阶段、manual/scheduled 恢复、reference MCP 幂等、文档和 61 字段 CSV 权威。

## Provider 预检

```bash
npm run verify:provider       # 开发机，当前默认
npm run verify:provider:prod  # 生产 SSE 路由诊断
```

两个命令都只发送 initialize、initialized notification、tools/list。开发机 PASS 要求 15 个工具存在且 required/type/forbidden 与 `mvp-v2` 兼容。当前没有公开向量工具；生产域名恢复前不得将开发结果表述为生产 Provider 已就绪。

## reference MCP

reference 服务不访问网络，结果在 MCP 外层标记 `simulated=true`、`productionEvidence=false`。不得把 reference MCP 的 simulated=true 当作生产成功；它不能证明数据库约束、provider 引用、cron 或企微通知已部署。

## 上线门禁

生产就绪还需数据库迁移/唯一键、provider schema hash、真实分发引用、首次 sync 快照、cron 单例和凭据轮换证据。任何一项缺失都保持 BLOCKED。
