# CHG-2026-003：修复根目录干净安装入口

```yaml
task_id: CHG-2026-003
change_type: bugfix-tooling
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 明确要求修复已确认的一键安装缺陷，并要求走 Spec 流程"
baseline: "main@fb5ac8603d1c5e26eacaaef4f99d06e6b6915b65"
rollback_strategy: "revert 本变更提交；删除根 workspace 配置并恢复原根 package-lock.json"
```

## Problem Evidence

仓库清理掉全部 `node_modules` 后，按根 README 执行：

```bash
npm ci
npm run verify
```

根安装只增加 13 个包；验证在 `YPmcn` 构建阶段以 `tsc: command not found` 退出。分别在 `YPmcn/` 与 `vector-mcp/` 执行 `npm ci` 后，同一提交的 172 项离线验证全部通过。因此缺陷属于根安装图不完整，不是产品实现或正式 Spec 失败。

## Decision

1. 根 `package.json` 声明 `YPmcn` 与 `vector-mcp` 为唯一 npm workspaces。
2. 根 `package-lock.json` 锁定完整 workspace 依赖图，使一次根 `npm ci` 同时准备两个可构建组件。
3. 组件 `package.json` 继续拥有各自运行时与开发依赖；不把 TypeScript 或 OpenClaw 依赖提升为根组件所有权。
4. 组件锁文件继续支持组件级独立安装；回归测试同时约束根锁文件与组件清单一致。
5. `npm run verify` 只验证，不在运行中隐式安装依赖或修改源码。
6. 本变更不修改 Database、MCP、Skill、Hook、Workflow、Error 或 Algorithm 契约，正式 Spec 版本保持不变。

## Scope

### Included

- 增加根 npm workspace 安装图及锁文件。
- 先增加稳定失败的根安装图回归测试，再实施修复。
- 将回归测试纳入统一离线验证入口。
- 修正文档中的干净安装说明和测试清单。
- 记录故障根因、验证证据和预防规则。

### Excluded

- 不修改 `spec/**`、任何 Tool Schema、工作流阶段、错误码或算法规则。
- 不修改 `YPmcn/package.json`、`vector-mcp/package.json` 或组件源码。
- 不访问或修改生产 provider、数据库、企微、凭据或客户数据。
- 不配置 Git remote，不发布或 push。
- 不把依赖安装逻辑塞进 `verify.mjs`。

## Task Boundary

```yaml
goal: "让全新工作树通过一次根 npm ci 准备全部组件，并可直接执行统一验证"
allowed_paths:
  - "changes/CHG-2026-003-root-workspace-install.md"
  - "changes/CHG-2026-003-root-workspace-install-impact.md"
  - "package.json"
  - "package-lock.json"
  - "scripts/verify.mjs"
  - "tests/root_workspace_install.test.mjs"
  - "tests/test_skill_package.py"
  - "README.md"
  - "docs/DEVELOPER_SPEC_WORKFLOW.md"
  - "docs/integration-readiness.md"
  - "fix-logs/CHG-2026-003-root-workspace-install.md"
  - "workflows/verifications/CHG-2026-003-root-workspace-install.json"
forbidden_paths:
  - "spec/**"
  - "YPmcn/**"
  - "vector-mcp/**"
  - "reference-mcp/**"
  - "packages/releases/**"
  - ".github/workflows/**"
  - ".env*"
acceptance:
  - "根 package.json 精确声明 YPmcn 与 vector-mcp 两个 workspace"
  - "根 package-lock.json 完整锁定两个 workspace 及其依赖，且与组件清单一致"
  - "删除全部依赖与 dist 后，一次根 npm ci 成功，随后 npm run verify 通过"
  - "npm run pack:yp 通过，发布包密钥扫描为零发现，packages/.staging 被清理"
  - "正式 Spec、组件清单、组件源码和生产外部系统均不变化"
verification:
  - "node --test tests/root_workspace_install.test.mjs（修复前 FAIL，修复后 PASS）"
  - "npm ci"
  - "npm run verify"
  - "npm run pack:yp"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
  - "git status --short"
rollback: "revert 本变更提交；根安装恢复为组件分别 npm ci，不涉及数据回滚"
```

## Implementation Order

1. 冻结 Change Proposal 与 Impact Analysis。
2. 增加根 workspace/lock 一致性测试并确认在基线稳定失败。
3. 增加根 workspace 配置并只更新根锁文件。
4. 更新验证入口、开发文档和 Fix Log。
5. 从无依赖、无 `dist` 状态执行根安装、全量验证和打包。
6. 冻结提交，由 OpenCode 基于 `base_sha..head_sha` 只读验证。

## Rollback

- 代码与文档：revert 本变更提交。
- 安装产物：`node_modules` 与 `dist` 均为可重建 ignored 文件，不参与回滚。
- 数据与外部系统：本变更无数据库 Migration、生产调用、凭据或网络写副作用。

## Scope Amendment — 2026-07-12

回归测试接入统一门禁后，测试总数由 172 增至 173；现有 `tests/test_skill_package.py` 会校验集成就绪报告中的精确测试清单。因此在修改该报告前，将此文档一致性断言加入允许路径。该调整只同步既有测试证据，不扩大生产实现或正式 Spec 范围。

独立验证完成后，按 `workflows/verification.template.json` 将 OpenCode 的机器可读结果固化到 `workflows/verifications/CHG-2026-003-root-workspace-install.json`。该文件仅记录冻结 SHA、命令和证据，不参与运行时或发布包。

## Result — 2026-07-12

```yaml
status: PACKAGED
implementation_sha: "9ff99c92ecaed2ee372eead4677934380a90f036"
verifier: "OpenCode / yuepu/Deepseek-V4-Pro / read-only"
verification_result: PASS
findings: 0
verification_evidence: "workflows/verifications/CHG-2026-003-root-workspace-install.json"
```

- 修复前回归测试稳定失败；加入根 workspace 安装图后转为通过。
- 从无依赖、无 `dist` 的工作树执行一次根 `npm ci`，随后 173 项统一验证全部通过。
- `npm run pack:yp`、tracked 密钥扫描、staging 清理与发布包哈希核对通过。
- 正式 `spec/**`、组件 manifest/源码、CI、生产 provider、数据库和发布包源码均未修改。
- 生产 provider 与数据库上线门禁仍保持原 `NO-GO`，不属于本变更修复范围。
