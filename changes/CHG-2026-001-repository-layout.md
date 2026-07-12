# CHG-2026-001：统一项目目录与 Spec 权威入口

```yaml
task_id: CHG-2026-001
change_type: refactor
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 明确要求按 Spec-Driven 文档整理项目"
baseline: "codex/contract-first-automation@06b2aad"
rollback_strategy: "回退本变更提交；分支与原 worktree 提交均保留"
```

## Decision

1. `/Users/jasper/Documents/YPmcn-skill` 是唯一长期项目根目录。
2. `/Users/jasper/Documents/YPmcn-worktrees` 只存放执行期 Git worktree；任务合并后移除，不作为项目打开或发布目录。
3. 产品基线采用 `codex/contract-first-automation@06b2aad`。晚于本流程文档、且角色分工与当前规则冲突的 `codex/ypmcn-agent-flow` 作为实验分支保留，不直接合并；`codex/portable-plugin-core` 同样保留。
4. 根目录建立 `spec/`、`changes/`、`src/`、`tests/`、`workflows/`、`packages/`、`docs/`、`fix-logs/`。现有 `YPmcn/` 保留为可发布 npm 插件组件，避免无收益的大规模源码搬迁。
5. 受版本控制的正式契约只存在于根 `spec/`。插件包中的 `spec/` 只能由打包脚本从根 Spec 生成，不得作为开发源编辑。
6. 现有 JSON 契约格式保留，因为已具备运行时校验且无需新增 YAML 解析依赖；目录、权威性和领域边界遵循流程文档。

## Scope

### Included

- 将现有正式契约从 `YPmcn/spec/` 迁到根 `spec/`。
- 将当前 `mvp-v2` 工具契约命名为 `spec/mcp.json`，保留 legacy 检测 profile。
- 补齐 `spec/manifest.json`、`spec/skills.json`、`spec/hooks.json`、`spec/algorithms.json` 与治理说明。
- 添加 Spec 漂移测试，并把它纳入统一验证入口。
- 建立 `changes/`、`workflows/`、`packages/`、`fix-logs/` 的职责边界和模板。
- 让打包产物统一输出到 `packages/releases/`，打包 staging 位于被忽略的 `packages/.staging/`。
- 更新当前 README、Agent 约束、Skill 引用、测试和脚本路径。
- 验收后将本分支快进到 `main`，保留用户未提交的 Mac Alias 和 draw.io 修改。

### Excluded

- 不修改 MCP Tool 的参数、返回值、错误码或业务语义。
- 不修改数据库 Schema、生产数据、Migration 或 provider。
- 不合并、不删除 `codex/ypmcn-agent-flow` 与 `codex/portable-plugin-core` 的提交。
- 不发布、不 push、不调用生产写工具。
- 不把 `YPmcn/`、`vector-mcp/`、`reference-mcp/` 做大规模物理重构。

## Task Boundary

```yaml
goal: "建立单一项目根、单一 Spec 权威入口和可验证的维护目录"
allowed_paths:
  - "spec/**"
  - "changes/**"
  - "workflows/**"
  - "packages/README.md"
  - "fix-logs/**"
  - "docs/**"
  - "README.md"
  - "AGENTS.md"
  - ".gitignore"
  - "package.json"
  - "YPmcn/**"
  - "reference-mcp/**"
  - "scripts/**"
  - "tests/**"
forbidden_paths:
  - "doc/**"
  - ".env*"
  - "node_modules/**"
  - "vector-mcp/src/**"
  - ".github/workflows/**"
acceptance:
  - "从根目录可唯一定位全部正式契约，且不存在受版本控制的 YPmcn/spec 副本"
  - "Spec manifest 覆盖 database、mcp、hooks、skills、workflow、errors、algorithms"
  - "插件运行时与发布包均可读取同一版本的 Spec"
  - "统一验证和打包测试通过，产物只写入 packages/"
  - "main 的用户本地修改不丢失"
verification:
  - "npm run verify"
  - "npm run pack:yp"
  - "git status --short"
```

## Migration Order

1. 冻结 Change Proposal 与 Impact Analysis。
2. 迁移 Spec 路径并先修复加载器、消费者和契约测试。
3. 增加缺失领域 Spec 与 manifest 漂移门禁。
4. 建立维护目录、打包 staging 和文档入口。
5. 全量离线验证并生成发布包。
6. OpenCode 使用不同模型只读验证冻结 diff。
7. 快进 `main`，移动历史本地 tgz，归档分支并移除 clean worktree。

## Rollback

- 代码：将 `main` 移回整合前提交或 `git revert` 本变更提交。
- Spec：本变更仅迁移路径和补治理契约，不改变既有 MCP/数据库/工作流语义；回退后原 `YPmcn/spec/` 路径恢复。
- 本地文件：用户未提交内容在整合前后均保持原工作树状态；历史 tgz 只移动、不删除。

