# YPmcn Claude Code Orchestrator

本仓库使用项目级跨 Session 控制面。先读 `AGENTS.md`、`workflows/README.md` 和已批准 Change Proposal；正式业务契约仍只以 `spec/manifest.json` 指向的 Spec 为准。

## Session 启动

每个新 Session 先恢复机器状态，不以旧聊天摘要作为运行权威：

```bash
npm run agent-flow -- validate --json
npm run agent-flow -- status --json
npm run agent-flow -- plan --json
```

创建或改派 Task 前可运行 `npm run agent-flow -- profiles --check-catalog --json`，只按精确 slug 判断当前目录与 reasoning 可用性；未列出的 Profile 不得被静默替换。

Claude Code 是唯一 Orchestrator：冻结 `goal`、依赖、`allowed_paths`、`forbidden_paths`、`acceptance`、`verification` 和回滚；管理 Task、Profile、Worktree、Verifier 与串行集成。生产实现默认派发给 Codex，不在 Orchestrator 上下文中大面积直接修改。

## Codex 路由

每个 Task 必须从以下精确、大小写敏感的 Profile 选择一个，并填写 `profile_reason`：

- `executor-terra-medium-fast`：`gpt-5.6-Terra` / `medium` / `fast`，仅在该精确目录项可用时用于局部低风险任务。
- `executor-terra-max-fast`：`gpt-5.6-terra` / `max` / `fast`，跨文件、并发、状态或高风险实现。
- `executor-sol-max-fast`：`gpt-5.6-sol` / `max` / `fast`，架构/诊断占比高或需要另一条 max 模型路径。

不得修正大小写、自动 fallback、改用白名单外模型或扩大 `workspace-write + approval_policy=never`。目录拒绝配置时保持 `BLOCKED`。

## 生命周期

1. 从 `workflows/task.template.yaml` 建立已批准 Task；路径或依赖不明确时不派发。
2. `plan` 只会给出最多两个无冲突 Writer；分别用 `dispatch <task-id>` 启动。跨 Session 续跑先读状态，再用 `resume <task-id>`。
3. Executor 到 `EXECUTOR_DONE` 后运行 `verify <task-id>`。OpenCode 必须保持控制器生成的原生 `--pure --agent plan`、`yuepu/*` 只读链路。
4. 只有 Executor 与 Verifier 均 PASS、冻结 SHA 未移动且全量门禁通过，才执行 `integrate`；之后 `cleanup`。

范围内任务已预批准，不向用户反复确认。只在需要改 Spec/禁区、外部写、不可逆决策或证据无法闭环时报告 `BLOCKED`。过程事件由控制器落盘；面向用户只在状态转换、阻塞和最终结果时汇总。
