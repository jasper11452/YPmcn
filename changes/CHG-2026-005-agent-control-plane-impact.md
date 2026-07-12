# CHG-2026-005 Impact Analysis

```yaml
task_id: CHG-2026-005
status: ANALYZED
risk_level: medium
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Domain Impact

| Domain | Change | Evidence / Constraint |
| --- | --- | --- |
| Database | No | 不改 Schema、Migration、writer ownership、数据或生产证明。 |
| MCP | No | 不改业务 Tool、输入输出、错误和副作用。 |
| Skill / Hook | No | 不改 YPmcn Skill、Hook、守卫或会话投影。 |
| Workflow / Error | No | 不改产品阶段、恢复或错误契约；新增的是仓库开发控制面。 |
| Algorithm | No | 保持 `external-unverified`，不推断业务算法。 |
| Developer Tooling | Yes | 新增任务控制器、Profile、状态、调度、验证和集成协议。 |
| Documentation | Yes | 更新 Agent/开发者/Workflows 使用规则和人类索引。 |
| Test | Yes | 新增控制面回归测试并纳入统一门禁。 |
| Packaging | No | 控制器、任务和验证工件不进入 YPmcn 发布包。 |

## State And Ownership

- `workflows/tasks/*.yaml` 是受版本控制的任务定义和初始状态，不由 Executor/Verifier 修改。
- 运行态位于 Git common dir 的 `agent-flow/tasks/*.json`；所有 Worktree 共享同一状态，但不会污染任一工作树。
- Claude/控制器是运行态唯一 Writer；Codex/OpenCode 只通过结构化输出交付结果。
- `workflows/verifications/*.json` 是最终可审计证据，只在冻结 SHA 验证后写入。
- Worktree 分支和 commit 是代码状态权威；模型文本声明不是权威。

## Compatibility

- 使用当前 Node.js ESM、Git CLI、Codex CLI 和 OpenCode CLI。
- Task 继续采用现有 YAML 形式；根显式依赖 `yaml`，避免手写不完整解析器。
- 三个 Profile 使用 Codex 当前公开支持的 `model`、`model_reasoning_effort`、`service_tier`、`sandbox_mode` 和 `approval_policy` 键。
- Profile 名是稳定路由标识；模型字符串按用户输入保持精确大小写。
- 控制器不要求 Codex App UI，优先使用可恢复的 `codex exec`。

## Risks And Mitigations

| Risk | Level | Mitigation |
| --- | --- | --- |
| 大小写不同的 Terra 模型实际指向无效目录项 | Medium | 2026-07-12 当前 catalog 只列出 `gpt-5.6-terra`，未列 `gpt-5.6-Terra`；按用户白名单严格保留，真实派发失败时 `BLOCKED`，不自动归一化或降级。 |
| `max` reasoning 不被目标模型接受 | Medium | Profile 安装只验证配置结构；真实目录/模型拒绝时保留原错误并 `BLOCKED`。 |
| 自动控制器越权执行 | High | 固定 `workspace-write + never`、路径白名单、无 full access、外部写/生产动作禁止。 |
| 并行任务修改重叠文件 | High | 派发前做 glob 保守交集检测；共享 Spec/锁/Manifest 默认串行。 |
| 高频状态写入污染 main | Medium | 运行状态放 Git common dir；版本库只保存任务定义和最终证据。 |
| Verifier 意外写入 | High | 调用前后比较 Git 状态和两个 plan 目录；任何差异直接 FAIL。 |
| 自动集成掩盖冲突 | High | 只允许状态/依赖/验证均 PASS；冲突和全量 verify 失败保持阻断。 |
| 控制器自身测试调用真实模型 | Medium | 测试使用假 CLI 和临时 Git 仓库；真实模型目录只做人工/运行期检查。 |
| Claude Orchestrator 不可用或卡住 | Medium | Task 定义和状态不依赖聊天；允许新 Claude Session 从持久状态恢复。 |
| 原始 JSONL/Prompt 污染仓库 | Low | 原始运行证据保存 Git common dir，不纳入版本控制。 |

## Rollback

- 代码、模板、测试和文档通过 revert 回滚。
- 删除 `/Users/jasper/.codex/executor-sol-max-fast.config.toml`、`executor-terra-max-fast.config.toml`、`executor-terra-medium-fast.config.toml`。
- 删除 Git common dir 下的 `agent-flow/` 只会移除开发运行态，不影响提交、分支、业务数据或正式 Spec。
- 本变更无生产调用、凭据、数据库 Migration 或发布副作用。

## Open Questions

- 当前 `codex debug models` 精确匹配到 `gpt-5.6-sol`、`gpt-5.6-terra`，二者均声明支持 `max`；未匹配到大小写不同的 `gpt-5.6-Terra`。用户要求禁止归一化，因此第三档继续原样安装，并在真实派发时按 fail-closed 处理。
