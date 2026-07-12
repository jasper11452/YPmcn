# CHG-2026-008：锁定业务 MCP canonical namespace

```yaml
task_id: CHG-2026-008-NAMESPACE
change_type: contract
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户要求按 2026-07-12 检测结果契约优先修复，并已授权继续执行下游运行时修复"
baseline: "main@f93e4fcb71a7b0fb37d275f2965871e23075f553"
rollback_strategy: "revert 本变更提交；不连接 provider、不修改运行时或发布包"
```

## Problem

CHG-2026-007 已锁定 15 个业务工具及其输入输出，但 `spec/mcp.json` 没有声明 Host Hook 事件中的 canonical MCP namespace。当前 Hook 仅按工具名后缀识别 `mcp__*__<tool>`，因此外部 namespace 可以伪装成同名业务工具；测试使用 `ypmcn`，本地 `vector-mcp` 配置又是完全不同的向量工具服务，二者不能由实现自行推断或混用。

## Decision

1. `spec/mcp.json` 新增唯一的 `serverIdentity` 契约，业务 MCP canonical namespace 固定为 `ypmcn`。
2. Host Hook 中的业务工具名必须精确匹配 `mcp__ypmcn__<contract-tool>`；其他 namespace 与 bare tool event 均不得作为 YPmcn 业务工具授权或结果证据。
3. MCP provider 协议自身的 `tools/list` 继续使用 Spec 中的 bare tool names；namespace 只定义 Host 对已配置 server 的限定名称，不改变 provider tool schema。
4. 本地 `vector-mcp` 明确不是 `mvp-v2` 业务 provider，不得通过改名或 fallback 冒充 `ypmcn`。
5. 外部生产 provider 仍须通过只读 initialize、notification 与 `tools/list` 兼容性检查；当前 legacy provider 不获得执行权，生产结论保持 **NO-GO**。

## Task Boundary

```yaml
goal: "为 mvp-v2 业务工具锁定唯一 Host MCP namespace，并提供机器门禁"
allowed_paths:
  - "changes/CHG-2026-008-mcp-namespace.md"
  - "changes/CHG-2026-008-mcp-namespace-impact.md"
  - "spec/mcp.json"
  - "YPmcn/src/contract/types.ts"
  - "YPmcn/src/contract/loader.ts"
  - "YPmcn/tests/contract-spec.test.mjs"
  - "tests/spec_governance.test.mjs"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "docs/integration-readiness.md"
  - "workflows/tasks/CHG-2026-008-NAMESPACE.yaml"
  - "workflows/verifications/CHG-2026-008-NAMESPACE.json"
forbidden_paths:
  - "YPmcn/src/hooks/**"
  - "YPmcn/skills/**"
  - "reference-mcp/**"
  - "vector-mcp/**"
  - "packages/**"
  - ".github/**"
  - ".env*"
acceptance:
  - "Spec 唯一声明 canonical namespace `ypmcn` 与精确 Host 限定名规则"
  - "机器测试证明 foreign namespace、bare Hook event 与 vector-mcp 不具备业务工具身份"
  - "provider tools/list 的 bare tool contract 与 Host namespace 语义不混淆"
  - "legacy detection-only、external-unverified 与生产 NO-GO 边界不被弱化"
verification:
  - "npm run verify:spec"
  - "npm run verify:docs"
  - "npm run verify"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
rollback: "revert 契约提交；没有运行时、provider、数据库或发布副作用"
```

## Dependency

本变更完成并集成后，Hook/Skill 实现才可消费该 namespace；Reference MCP 实现不依赖 Host namespace，但与 Hook/Skill 并行前共同冻结在本变更后的 main SHA。
