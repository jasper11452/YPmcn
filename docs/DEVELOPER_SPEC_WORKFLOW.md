# 人类开发者 Spec-Driven Development 使用手册

第一次了解项目先读 `docs/README.md`、`docs/PROJECT_MAP.md` 和 `docs/EVOLUTION.md`；本手册只说明如何安全修改。

## 1. 从哪里打开项目

只把 Git 主工作树当作长期项目。`../YPmcn-worktrees/` 是临时隔离空间，里面每个目录对应某个任务分支；它们不是第二个项目，也不应成为发布或日常编辑入口。

`YPmcn/` 是仓库内的可发布 OpenClaw 插件组件，不是另一个 Git 项目。保留组件边界可以维持 npm 构建与发布结构，同时由根目录统一治理 Spec、测试和产物。

## 2. 目录职责

```text
project/
├── spec/          # 唯一已批准机器契约
├── changes/       # 需求、提案、影响分析和决策
├── src/           # 根级共享边界，当前无独立运行时
├── tests/         # 仓库级契约、集成和发布测试
├── packages/      # staging 与 tgz 构建产物
├── docs/          # 使用、架构和流程文档
├── fix-logs/      # 重要故障根因与预防经验
├── YPmcn/         # 可发布 Skill/Hook 插件组件
├── vector-mcp/    # 向量检索 MCP 组件
└── reference-mcp/ # 无网络、非生产证据的参考 MCP
```

| 目录 | 修改规则 |
|---|---|
| `spec/` | 仅通过已批准 Change Proposal 修改 |
| `changes/` | 可创建和追加决策证据，不回写已发布历史 |
| `src/`、组件源码 | 仅按已批准 Spec 和任务路径边界修改 |
| `tests/` | 随变更同步更新，禁止弱化 |
| `packages/` | 自动生成，不手工编辑 |
| `fix-logs/` | 重要问题闭环后追加 |

`doc/` 只暂留 Algorithm Spec 引用的来源 Alias；它不是机器事实源。来源资料与 Spec 冲突时，先走 Change Proposal 更新 Spec，不让实现自行裁决。

## 3. 关键概念

- Spec：定义系统应该是什么，入口是 `spec/manifest.json`。
- Change Proposal：回答为什么改、改什么、不改什么、兼容性、验证、回滚和负责人。
- Impact Analysis：确认 Database、MCP、Skill、Hook、Workflow、Error、Algorithm 和测试的连锁影响。
- Contract Test：证明多个实现层对同一契约理解一致，防止 Contract Drift。

## 4. 日常变更流程

```text
需求
→ Change Proposal
→ Impact Analysis
→ Spec Approval
→ 按依赖与文件所有权拆任务
→ 独立 worktree 实施
→ 自动验证
→ 独立 Review
→ Package Gate
→ Release
```

涉及字段、Tool、错误码、权限、Hook 阻断、阶段或算法输入输出时，Change Proposal 未批准前不启动正式实现。内部重构、日志、测试补充或文档错字通常不改对外 Spec，但仍需有界任务和验证。

根 `npm ci` 会自动启用版本化 pre-commit hook。Spec 或正式 Change Proposal 完整暂存后直接提交，hook 会同步并暂存三份人类文档；正常流程不需要手动执行同步命令。若相关来源存在部分暂存、未暂存或未跟踪内容，hook 会拒绝提交，避免扩大提交范围。

需要提交前即时预览或修复时才运行：

```bash
npm run docs:sync
```

同步逻辑只更新三份人类文档中的机器事实区块。自动提交后仍要人工检查结构解释、原则和演进原因是否需要调整，再运行只读 `npm run verify:docs` 并进入完整验证。

## 5. 任务与并行

日常任务只需明确目标、允许/禁止路径、验收条件和最小验证命令，不创建额外任务状态文件。

- Fast 由 Claude Code 直接完成。
- Standard 可将一个小而明确的实现任务交给 Codex，最终由 Claude Code 验收和提交。
- Critical 使用隔离 worktree，并由 OpenCode 独立只读验证一次。

只有以下条件全部满足才并行：

- 基于同一已批准 Spec。
- 不改同一文件或同一契约定义。
- 一个任务的输出不是另一个任务的输入。
- 各自有独立 worktree、分支和验证命令。

Spec → Database → MCP → Hook/Skill → 集成测试 → Package 等真实依赖保持串行。普通开发不使用 Workflow、跨 Session 状态机、JSONL 或验证证据目录。

## 6. 测试门禁

每次变更评估 Unit、Contract、Integration、E2E、Regression 和 Migration Test。Bug 修复顺序固定为：复现 → 失败测试 → 最小修复 → 测试转绿 → 相邻回归 → Fix Log。

```bash
# 从干净工作树一次安装根包、插件和向量 MCP 的锁定依赖
npm ci

# 仓库离线门禁
npm run verify

# 生成并扫描发布包
npm run pack:yp

# 生产 provider 只读兼容性门禁
npm run verify:provider
```

根 `package.json` 将 `YPmcn` 与 `vector-mcp` 声明为 npm workspaces，根 `package-lock.json` 是统一安装图。`npm run verify` 不隐式安装依赖；全新工作树先执行一次根 `npm ci`，无需对子组件重复安装。

构建成功不等于工作流正确；契约、集成、发布包和生产外部证据是独立门禁。reference MCP 的 `simulated=true` 不能作为生产成功证据。

## 7. Review 与发布

Reviewer 检查 Change Proposal、Impact Analysis、Spec 同步、跨层一致性、兼容性、Migration、权限/数据风险、测试覆盖和无关修改。实现者与 Verifier 使用不同模型或上下文链路。

发布必须依次满足：Spec Approved → Implementation Complete → Tests Passed → Reviewer Approved → Package Verified → Release Approved。任何关键门禁失败时保持阻断，不通过降低 Schema、跳过测试或恢复 Mock 成功来换取绿色状态。
