# CHG-2026-012：升级项目级 Agent Flow 至 V2.2

```yaml
task_id: CHG-2026-012
change_type: developer-tooling
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-14 要求仅在 YPmcn-skill 试点执行 Agent 低 Token 稳定开发流程 V2.2，并确认固定模型、五并发与风险优先级"
baseline: "main@f1e8f4713dcf92d2bcd2386eb4a0320b09e4301c"
rollback_strategy: "revert 本变更；Git common dir 中的 V2.2 运行态可删除，不影响业务数据"
```

## Problem

现有控制器已经提供项目身份检查、双 Writer、Worktree、Codex 派发、OpenCode 只读验证和串行集成，但仍是 V2.1 风格：Executor 模型为三档 Terra/Sol max/medium、并发上限为 2、所有任务走同一独立验证路径，且缺少 V2.2 lane、上下文快照、状态 revision、不可变结果和全链路指标。

## Decision

1. 只在本仓库通过根 `CLAUDE.md`、项目 `.claude/settings.json` 和项目身份检查启用，不改变其他仓库的默认行为。
2. Claude Code Orchestrator 固定使用项目别名 `fable`，映射 `gpt-5.6-sol`，思考等级 `medium`。
3. Codex Executor 只允许 `gpt-5.6-sol`、`low`、`workspace-write`、`approval_policy=never`，真实调用显式传模型配置，不依赖静默 fallback。
4. OpenCode Verifier 首选 `yuepu/Deepseek-V4-Pro`；Standard-High 可在进程/格式故障时降级到 `yuepu/gpt-5.6-sol`、`medium`，Critical 不自动降级。
5. 新任务必须声明 `fast | standard-low | standard-high | critical`、路由证据、升级触发器、上下文引用、停止条件和独立验证策略；历史任务继续只读兼容。
6. 最多五个无依赖、无路径冲突 Writer；冲突任务自动留在后续批次。
7. 权威运行态使用单写者临界区、原子写、`state_revision` 和 JSONL 审计；Executor/Verifier 结果按内容哈希固化为不可变结果。
8. 派发时生成带来源哈希的任务上下文快照；记录可获得的 token、重试、墙钟时间和验证链路指标。
9. Fast/Standard-Low 在无升级触发器时允许控制器自验；Standard-High/Critical 必须独立验证，Critical 还必须有人工批准。
10. 系统不自动 commit、push、PR、merge 或发布；现有 `integrate` 仍是显式人工触发命令。
11. 项目级 Claude `PreToolUse` 阻止 Orchestrator 直接写生产文件；Codex 使用 workspace sandbox，控制器在派发前校验 realpath、完成后校验冻结 diff。Codex per-tool Hook 不通过全局配置伪装成项目级能力。

## Scope

### Included

- 项目级 Claude 设置与 Orchestrator 指令。
- Agent Flow Task/Runtime/Result 契约、模板、控制器和确定性测试。
- 五并发、lane 路由、动态升级、上下文快照、原子状态、不可变结果、事件与指标。
- OpenCode 主/备 Verifier 策略与写入检测。
- 工作流文档和当前任务定义。

### Excluded

- 不修改 `spec/**`、业务代码、数据库、Provider、Hook/Skill 产品逻辑或发布包。
- 不做 SQLite、Dashboard、团队/跨机器状态服务和完整 A/B 实验平台。
- 不清理现存 Claude Worktree，不修改全局 Claude/Codex/OpenCode 配置。
- 不自动集成到 `main`，不 push 或创建 PR。

## Task Boundary

```yaml
goal: "将现有项目级控制器兼容升级为可试点的 V2.2"
allowed_paths:
  - ".claude/settings.json"
  - "changes/CHG-2026-012-agent-flow-v22.md"
  - "changes/CHG-2026-012-agent-flow-v22-impact.md"
  - "workflows/**"
  - "scripts/agent-flow.mjs"
  - "scripts/agent-flow-hook.mjs"
  - "tests/agent_flow.test.mjs"
  - "AGENTS.md"
  - "CLAUDE.md"
  - "docs/EVOLUTION.md"
forbidden_paths:
  - "spec/**"
  - "YPmcn/**"
  - "vector-mcp/**"
  - "reference-mcp/**"
  - "packages/**"
  - ".github/**"
  - ".env*"
acceptance:
  - "项目级 Claude、Codex 与 OpenCode 模型配置精确匹配批准值"
  - "新任务四档路由、升级触发器和验证策略可机器校验"
  - "调度器最多选择五个无冲突 Writer"
  - "状态有 revision 和事件审计，结果不可变，上下文来源有哈希"
  - "Standard-High/Critical 独立验证；Critical 禁止自动 fallback"
  - "项目身份错误、路径逃逸、Verifier 写入和陈旧状态更新均 fail closed"
  - "控制面测试和仓库离线验证全部通过，业务目录零变化"
verification:
  - "node --test tests/agent_flow.test.mjs"
  - "npm run verify:agent-flow"
  - "npm run verify"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
  - "OpenCode read-only verification"
rollback: "revert 该变更；删除对应 Git common dir agent-flow 运行态"
```

## Implementation Order

1. 冻结 Change Proposal、Impact Analysis 和 V2.2 Task。
2. 添加失败测试，覆盖模型、lane、五并发、状态、上下文、不可变结果和 Verifier fallback。
3. 最小升级 Schema、模板和控制器，保持历史工件可读。
4. 运行控制面与仓库全量门禁。
5. 冻结 SHA 后使用 OpenCode 只读复验。
