# CHG-2026-004：建立极简人类文档与 Spec 同步门禁

```yaml
task_id: CHG-2026-004
change_type: documentation-governance
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 明确要求建立供人工快速理解的极简文档，并在 Spec 变更后同步更新"
baseline: "main@7daef96ba6b7b59cdfb362b184ff006ae360e810"
rollback_strategy: "revert 本变更提交；移除人类文档同步脚本、测试和验证入口"
```

## Problem

仓库已经具备完整机器 Spec、Agent 规则、测试和发布门禁，但人类需要在多个文件之间跳转才能回答三个基本问题：项目现在是什么、应该去哪里改、为什么演进成当前结构。人工检查成本仍然偏高。

## Decision

1. `docs/README.md` 成为人类第一入口，用一分钟说明项目、当前状态、阅读顺序和不可越过的边界。
2. `docs/PROJECT_MAP.md` 用一张目录/职责地图回答“什么内容在哪里、什么变更改哪里”。
3. `docs/EVOLUTION.md` 只保留关键转折和 Change Proposal 索引，不复制完整历史实现。
4. 三份文档包含受标记保护的生成区块。`scripts/sync-human-docs.mjs` 从 `spec/manifest.json`、全部正式契约、兼容 profile 和 `changes/CHG-*.md` 生成当前事实与 SHA-256 摘要。
5. `npm run docs:sync` 更新生成区块；`npm run verify:docs` 与统一 `npm run verify` 检查区块是否最新。Spec 或 Change Proposal 改动后未同步时必须失败。
6. 自动区块只同步机器事实；结构解释、原则和演进原因仍由人维护。正式契约始终只有根 `spec/`。
7. 每份人类文档设置长度上限和链接检查，防止再次膨胀为第二套长 Spec。

## Scope

### Included

- 新增三份极简人类文档。
- 新增无依赖、确定性的文档同步脚本和 `--check` 模式。
- 新增同步、长度、入口和本地链接回归测试，并纳入统一验证。
- 更新 Agent、开发者流程、根 README 和就绪报告中的人类文档入口与测试清单。
- 统一测试总数从 173 更新为 175。

### Excluded

- 不修改 `spec/**` 或任何业务契约语义。
- 不修改 `YPmcn/**`、`vector-mcp/**`、`reference-mcp/**` 或发布包内容。
- 不访问生产 provider、数据库、企微、凭据或客户数据。
- 不自动改写人工叙事段落，不从实现反推业务规则。
- 不配置 remote，不发布或 push。

## Task Boundary

```yaml
goal: "让人类在十分钟内理解项目，并让机器事实在 Spec/Change 变化后自动同步和受验证"
allowed_paths:
  - "changes/CHG-2026-004-human-documentation.md"
  - "changes/CHG-2026-004-human-documentation-impact.md"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "docs/AGENT_SPEC_WORKFLOW.md"
  - "docs/DEVELOPER_SPEC_WORKFLOW.md"
  - "docs/integration-readiness.md"
  - "README.md"
  - "AGENTS.md"
  - "package.json"
  - "scripts/sync-human-docs.mjs"
  - "scripts/verify.mjs"
  - "tests/human_docs.test.mjs"
  - "tests/test_skill_package.py"
  - "workflows/verifications/CHG-2026-004-human-documentation.json"
forbidden_paths:
  - "spec/**"
  - "YPmcn/**"
  - "vector-mcp/**"
  - "reference-mcp/**"
  - "packages/releases/**"
  - ".github/workflows/**"
  - ".env*"
acceptance:
  - "人类入口、项目地图、演进文档分别回答是什么、去哪改、为什么演进"
  - "三份文档均保持在约定行数上限内，且本地 Markdown 链接有效"
  - "生成区块包含当前 profile、Spec 摘要、领域映射和 Change Proposal 索引"
  - "任一正式 Spec 或 CHG 内容变化都会使 verify:docs 失败，直到执行 docs:sync"
  - "AGENTS 与开发流程明确要求 Spec 完成后同步并人工复核人类文档"
  - "npm run verify 与 npm run pack:yp 通过；正式 Spec 和组件源码零变化"
verification:
  - "node --test tests/human_docs.test.mjs（实现前 FAIL，实现后 PASS）"
  - "npm run docs:sync"
  - "npm run verify:docs"
  - "npm run verify"
  - "npm run pack:yp"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
  - "OpenCode read-only verification"
rollback: "revert 本变更；现有 Agent/Spec/运行时不受影响"
```

## Implementation Order

1. 提交 Change Proposal 与 Impact Analysis。
2. 先添加失败测试，锁定同步、精简度和入口要求。
3. 实现同步脚本与三份人类文档。
4. 接入根脚本、统一验证和 Agent/开发者规则。
5. 同步事实区块，运行全量验证和打包。
6. 冻结提交，由 OpenCode 只读验证后快进 `main`。

