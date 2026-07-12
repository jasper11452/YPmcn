# CHG-2026-005：将人类文档同步改为提交前自动执行

```yaml
task_id: CHG-2026-005
change_type: tooling-governance
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 明确要求项目修改后自动更新人类文档，不应依赖人工运行 docs:sync"
baseline: "main@26b98bfb75039b36cf99ec20b428518138f3b83c"
rollback_strategy: "revert 本变更；移除仓库 hook 与 prepare 安装脚本，恢复手动同步流程"
```

## Problem

CHG-2026-004 已能确定性生成三份人类文档，并在漂移时阻断验证，但正常流程仍要求人或 Agent 手动运行 `npm run docs:sync`。这会把一致性责任留给记忆，不符合自动化项目的维护目标。

## Decision

1. 把仓库事实更新边界定义为 Git 提交，而不是每次文件保存。未提交草稿不代表项目事实；避免引入常驻 watcher、后台写入竞态和机器级服务。
2. 新增受版本控制的 `.githooks/pre-commit`。当暂存内容包含 `spec/**` 或正式 `changes/CHG-*.md` 时，hook 自动更新三个生成区块并把对应文档加入当前提交。
3. hook 在同步前检查相关来源和人类文档是否存在未暂存或未跟踪变化。部分暂存时 fail closed，禁止把工作树中未选择的内容意外带入提交。
4. `npm ci` 通过无依赖 `prepare` 脚本自动设置本仓库的 `core.hooksPath=.githooks`；非 Git 环境安全跳过。
5. `npm run docs:sync` 只保留为即时预览、修复和调试入口；正常提交不要求人工运行。
6. `npm run verify:docs` 与统一 `npm run verify` 继续保持只读，只验证最终一致性，不在验证阶段静默修改源码。
7. 根 `spec/` 仍是唯一正式契约，人类叙事仍需人工审阅；自动化只同步已定义的机器事实区块。

## Scope

### Included

- 新增并自动安装仓库级 pre-commit hook。
- 新增提交触发、自动暂存、无关提交跳过和部分暂存阻断测试。
- 将 Agent、开发者和人类入口改成“提交自动、命令可选、验证只读”。
- 统一测试总数从 175 更新为 178。

### Excluded

- 不增加常驻文件 watcher、LaunchAgent 或 IDE 专属配置。
- 不修改 `spec/**`、业务契约、组件源码或发布包内容。
- 不自动改写 marker 外人工叙事。
- 不访问生产 provider、数据库、企微、凭据或客户数据。
- 不配置 remote，不发布或 push。

## Task Boundary

```yaml
goal: "让 Spec/正式 Change Proposal 在提交时自动同步人类文档，用户无需记忆手动命令"
allowed_paths:
  - ".githooks/pre-commit"
  - "changes/CHG-2026-005-automatic-human-docs.md"
  - "changes/CHG-2026-005-automatic-human-docs-impact.md"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "docs/AGENT_SPEC_WORKFLOW.md"
  - "docs/DEVELOPER_SPEC_WORKFLOW.md"
  - "docs/integration-readiness.md"
  - "README.md"
  - "AGENTS.md"
  - "package.json"
  - "scripts/install-git-hooks.mjs"
  - "scripts/pre-commit-human-docs.mjs"
  - "scripts/sync-human-docs.mjs"
  - "tests/human_docs.test.mjs"
  - "tests/test_skill_package.py"
forbidden_paths:
  - "spec/**"
  - "YPmcn/**"
  - "vector-mcp/**"
  - "reference-mcp/**"
  - "packages/releases/**"
  - ".github/workflows/**"
  - ".env*"
acceptance:
  - "根 npm ci 自动启用版本化 Git hook，非 Git 环境安全跳过"
  - "暂存 Spec 或正式 Change Proposal 后直接提交会自动同步并暂存三份人类文档"
  - "无关提交不改写人类文档；部分暂存或未跟踪相关来源时 fail closed"
  - "verify:docs 和统一 verify 保持只读，并继续阻断绕过 hook 的漂移"
  - "文档明确正常流程无需手动运行 docs:sync，且不声称文件保存时即时同步"
  - "npm run verify 与 npm run pack:yp 通过；正式 Spec 和组件源码零变化"
verification:
  - "node --test tests/human_docs.test.mjs（实现前 FAIL，实现后 PASS）"
  - "npm ci"
  - "npm run verify:docs"
  - "npm run verify"
  - "npm run pack:yp"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
  - "OpenCode yuepu/Deepseek-V4-Pro read-only verification"
rollback: "revert 本变更；现有 Spec、Agent 和运行时不受影响"
```

## Implementation Order

1. 提交 Change Proposal 与 Impact Analysis。
2. 先添加失败测试，锁定安装、自动同步和部分暂存安全性。
3. 实现版本化 hook、安装脚本和提交同步器。
4. 更新人类/Agent 流程并刷新生成区块。
5. 运行全量验证、打包和不同模型只读验收。
6. 快进 `main`、在主工作树启用 hook并清理临时目录。
