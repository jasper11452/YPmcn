# Agent Spec-Driven Development Guide

## 1. 角色与优先级

实施 Agent 是受约束的 Executor，不是拥有全仓库修改权的通用 Agent。目标是依据已批准 Spec 完成最小变更，并交付可审查、可验证、可回滚的结果。

```text
安全与数据完整性
> 已批准 Spec
> Change Proposal
> 测试与验证规则
> 当前代码实现
> Agent 推断
```

当前代码、聊天记录或旧文档与正式 Spec 冲突时，以根 `spec/manifest.json` 指向的已批准契约为准。Spec 缺失、矛盾或标为 `external-unverified` 时，停止对应契约实施并输出 `BLOCKED`；不得从实现反向发明规则。

需要向人解释项目时先读 `docs/README.md`、`docs/PROJECT_MAP.md` 与 `docs/EVOLUTION.md`，但契约判断仍回到根 `spec/`。

## 2. 唯一事实源

```text
spec/
├── manifest.json
├── database.json
├── mcp.json
├── hooks.json
├── skills.json
├── workflow.json
├── errors.json
├── algorithms.json
└── profiles/
```

- `mcp.json` 唯一定义 Tool 参数、返回、错误和副作用。
- `skills.json` 只定义可用 Tool、前置条件与交互策略，不复制 Tool Schema。
- `hooks.json` 只定义确定性守卫和生命周期事件，不拥有数据库或算法。
- `algorithms.json` 当前为 `external-unverified`；批准定义前禁止根据代码推断算法契约。
- `profiles/legacy-1.9.4.json` 只做只读检测，不授权执行或自动降级。
- 发布包中的 `spec/` 是构建快照，不是可编辑事实源。

## 3. 变更生命周期

```text
DRAFT → ANALYZED → SPEC_APPROVED → IMPLEMENTING
→ TESTING → REVIEWING → PACKAGED → RELEASED
```

不得跳过 Impact Analysis、Spec Approval、Test 或独立 Review。需要修改 Tool、字段、错误码、权限、Hook 阻断、工作流阶段或算法契约时，先改并批准 Spec，再实施代码。

## 4. 执行前输入

任务至少包含：

```yaml
task_id: CHG-YYYY-NNN-DOMAIN
change_type: feature
approved_spec_version: "mvp-v2 / schemaVersion 1"
change_proposal: "changes/CHG-YYYY-NNN-slug.md"
impact_analysis: "changes/CHG-YYYY-NNN-slug-impact.md"
allowed_paths:
  - "具体路径/**"
forbidden_paths:
  - "spec/**"
acceptance:
  - "可观察的完成条件"
verification:
  - "具体命令"
rollback: "回滚方式"
```

缺少 Change Proposal、关联 Spec、路径所有权、验证标准或完成条件时，不开始生产实现。

## 5. 影响分析

实施前在 `changes/<task-id>-impact.md` 记录：

- 变更目的与风险等级。
- Database、MCP、Skill、Hook、Workflow、Error、Algorithm 各域是否变化。
- 允许修改的文件和明确禁止的文件。
- 依赖顺序、兼容性、Migration、回滚与未决问题。

字段类型/唯一约束、必填 Tool 参数、返回结构、错误码、权限、写入/删除/发布、副作用和不可逆 Migration 属于高风险。

## 6. 文件所有权

| 责任域 | 允许修改 | 禁止越界 |
|---|---|---|
| Architect | Change Proposal、Impact Analysis、Spec 草案 | 未授权生产实现 |
| Database | Schema、Migration、索引、数据库测试 | Skill、Hook、Tool Schema |
| MCP | Tool 定义、校验、错误映射、实现 | 数据库 Schema、Skill Prompt |
| Skill | 信息收集、编排、Tool 前置条件、错误恢复 | Tool 参数、数据库字段、错误码定义 |
| Hook | 格式、权限、前置条件与风险阻断 | 模糊推理、数据库、算法契约 |
| Tester | 测试、Mock、报告 | 生产实现 |
| Reviewer | 只读审查与风险报告 | 业务代码 |
| Packager | 构建配置和包内容校验 | Prompt、Tool、数据库逻辑 |

除非任务明确授权，不修改 `spec/`、生产数据、密钥、CI 安全策略、锁文件、无关模块或其他任务拥有的文件。

## 7. 实施与测试

1. 阅读 Change Proposal、Impact Analysis、相关 Spec、实现、测试和 Fix Log。
2. 明确本任务负责/不负责、允许路径、依赖、风险和验证。
3. 只做完成验收所需的最小修改；不顺手重构、不弱化测试、不用 Prompt 绕过服务端门禁。
4. Bug 修复先写稳定复现测试，再修实现并跑相邻回归。
5. 契约变化至少覆盖正常、缺失、非法、权限/副作用、错误映射、幂等或回滚场景。
6. Spec 或正式 Change Proposal 完整暂存后由 pre-commit hook 自动同步人类文档；无需固定手动运行 `npm run docs:sync`。提交后人工复核叙事，再运行只读 `npm run verify:docs`。
7. 执行任务单中的全部命令；未运行的测试必须标记 `NOT RUN` 和风险。

本仓库离线总门禁：

```bash
npm run verify
```

生产 provider 是独立只读门禁，不纳入离线 PASS：

```bash
npm run verify:provider
```

## 8. Worktree 规则

- 长期项目根是主 Git 工作树；worktree 只是单任务执行空间。
- 并行任务只有在 Spec 已批准、无文件冲突、无输入依赖且各自可验证时才并行。
- 禁止多人或多个 Agent 在同一 worktree 写文件，禁止直接在 `main` 实施。
- 任务完成后报告分支、文件、验证、commit、风险和可合并性。
- 合并或归档后，确认 worktree clean、提交已保留，再移除临时目录。

## 9. 独立验证

默认链路：Claude Code 定义边界，Codex 在独立 worktree 实施，OpenCode 用不同模型或上下文只读验证。Verifier 必须检查冻结的 `base_sha..head_sha`，输出 `PASS / FAIL / BLOCKED + evidence`，不直接修生产代码。

项目内通过 `scripts/agent-flow.mjs` 落实该链路：

1. Claude 从 `workflows/task.template.yaml` 创建已批准 Task，并为每项任务填写一个精确、大小写敏感的 `execution_profile` 和选择理由。
2. 新 Session 先读 `status --json` 和 `plan --json`；运行态来自 Git common dir，不以聊天记录为恢复权威。
3. 控制器最多选择两个无依赖、无显式冲突、无路径交集的 Writer。共享 Spec、锁、Manifest/Schema、Migration、Package 与 main 集成继续串行。
4. `dispatch` 使用非交互 `codex exec`、`workspace-write`、`approval_policy=never` 和结构化输出；实时保存 JSONL、session ID、PID 和 checkpoint。旧进程仍存活时拒绝重复 `resume`。
5. OpenCode 只允许 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`、`--pure --agent plan` 和 `yuepu/*`。调用前后 Git 状态或任一 plan 目录变化时，无论模型声明什么都判 `FAIL`。
6. 只有 Executor 证据、Verifier 证据、路径边界和仓库全量 `npm run verify` 全部通过，控制器才允许串行集成。

三档 Codex Profile 与命令见 `workflows/README.md`。模型/Reasoning 不可用时保持 `BLOCKED`，不得改大小写、自动降级或扩大 sandbox。范围内无须用户逐项确认；需要 Spec、禁区、外部写或不可逆决定时才阻断。

Codex 作为后台 Executor 时，系统要求的交互式进度说明不属于任务完成协议。控制器消费事件流，Claude 只在状态转换、阻塞和最终结果时汇总，因此跨 Session 恢复不依赖聊天界面的报告频率。

## 10. 失败与阻塞

失败分类：`SPEC_DEFECT`、`IMPLEMENTATION`、`CONTRACT_DRIFT`、`TEST_DEFECT`、`ENVIRONMENT`、`DATA_MIGRATION`。

遇到以下情况输出 `BLOCKED`：Spec 缺失/冲突、未批准破坏性变更、Migration 安全不明、需要生产密钥/数据、前置任务未完成、文件所有权冲突或验证环境无替代方案。

## 11. 完成报告

完成时至少报告：Task ID、角色、分支、commit、修改范围、明确未修改项、各 Spec 对齐情况、验证命令及结果、已知风险、后续任务和是否可合并。
