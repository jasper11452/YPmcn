# YPmcn Claude Code Orchestrator

本仓库使用项目级跨 Session 控制面。先读 `AGENTS.md`、`workflows/README.md` 和已批准 Change Proposal；正式业务契约仍只以 `spec/manifest.json` 指向的 Spec 为准。

本文件和 `.claude/settings.json` 只在从本仓库启动 Claude Code 时生效。Orchestrator 固定为项目别名 `fable` → `gpt-5.6-sol`，思考等级 `medium`；不得把该配置推广到其他仓库。

## Session 启动

每个新 Session 先恢复机器状态，不以旧聊天摘要作为运行权威：

```bash
npm run agent-flow -- validate --json
npm run agent-flow -- status --json
npm run agent-flow -- plan --json
```

创建或改派 Task 前可运行 `npm run agent-flow -- profiles --check-catalog --json`，只按精确 slug 判断当前目录与 reasoning 可用性；未列出的 Profile 不得被静默替换。

Claude Code 是唯一 Orchestrator：冻结 `goal`、依赖、`allowed_paths`、`forbidden_paths`、`acceptance`、`verification` 和回滚；管理 Task、Profile、Worktree、Verifier 与串行集成。生产实现默认派发给 Codex，不在 Orchestrator 上下文中大面积直接修改。

## V2.2 路由与 Codex

新 Task 必须先按硬条件选择 `fast`、`standard-low`、`standard-high` 或 `critical`，并记录 `route_reason`、`upgrade_triggers`、`required_context` 和 `stop_conditions`。无法可靠分类时取较高 lane。

- V2.2 Executor 唯一 Profile：`executor-sol-low` → `gpt-5.6-sol` / `low` / `fast`。
- Fast/Standard-Low 默认由确定性门禁和相关测试自验；命中触发器时升级。
- Standard-High/Critical 必须由 OpenCode 独立验证。
- OpenCode 首选 `yuepu/Deepseek-V4-Pro`；仅非 Critical 的进程或格式故障可降级 `yuepu/gpt-5.6-sol` / `medium`。

不得自动改用白名单外模型或扩大 `workspace-write + approval_policy=never`。Critical 缺首选 Verifier 时保持 `BLOCKED`。

## 生命周期

1. 从 `workflows/task.template.yaml` 建立已批准 Task；路径或依赖不明确时不派发。
2. `plan` 最多给出五个无依赖、无路径冲突 Writer；分别用 `dispatch <task-id>` 启动。跨 Session 续跑先读状态，再用 `resume <task-id>`。
3. Executor 到 `EXECUTOR_DONE` 后运行 `verify <task-id>`；控制器按 lane 决定自验或 OpenCode L4。
4. 只有 Executor 与 Verifier 均 PASS、冻结 SHA 未移动且全量门禁通过，才执行 `integrate`；之后 `cleanup`。

范围内任务已预批准，不向用户反复确认。只在需要改 Spec/禁区、外部写、不可逆决策或证据无法闭环时报告 `BLOCKED`。过程事件由控制器落盘；面向用户只在状态转换、阻塞和最终结果时汇总。
