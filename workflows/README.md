# Cross-session Agent Control Plane

本目录保存 Claude Code → Codex → OpenCode 的项目级控制面。它只在通过 YPmcn Git 根、根包名和已批准 `mvp-v2` Spec 身份检查后工作；不会把本项目角色或状态机设成其他仓库的全局默认。

## 角色与权威

| 角色 | 工具 | 唯一职责 | 不允许 |
| --- | --- | --- | --- |
| Orchestrator | Claude Code | 冻结 Task、选 Profile、排依赖、派发、判定验收、串行集成 | 无边界地直接改生产代码 |
| Executor | Codex | 在任务独立 worktree 实施、自测、提交结构化证据 | 改 Spec/禁区、请求范围内重复确认、绕过 sandbox |
| Verifier | OpenCode | 用 `yuepu/*` 不同上下文只读复验冻结 diff | 修代码、写 plan、使用 `--auto` 或非 yuepu 模型 |

版本控制中的 `tasks/*.yaml` 是任务定义；Git common dir 的 `agent-flow/` 是跨 worktree/session 运行态；Git commit 是代码权威；`verifications/*.json` 只保存最终独立验收证据。模型文本不能覆盖 Git、退出码或路径边界。

## V2.2 固定模型与路由

本项目的 V2.2 新任务固定使用一个 Codex Profile；历史已归档任务中的旧 Profile 只读兼容。

| Profile | 精确模型 | Reasoning | Tier | 建议路由 |
| --- | --- | --- | --- | --- |
| `executor-sol-low` | `gpt-5.6-sol` | `low` | `fast` | 所有 V2.2 Codex 实现任务 |

任务风险另按 `fast / standard-low / standard-high / critical` 分类。Fast/Standard-Low 无触发器时走 L1/L2 自验；Standard-High/Critical 强制 OpenCode L4。Critical 必须有人类批准，且 Verifier 不自动 fallback。

## 状态与并行

```text
READY → DISPATCHED → EXECUTING → EXECUTOR_DONE
                                      ↓
                                  VERIFYING → PASS → MERGE_READY → MERGED → ARCHIVED
                                      ↓
                               FAIL/BLOCKED → REWORK_READY → DISPATCHED
```

- 最多五个 Codex Writer；派发锁保证多个 Claude Session 不会竞态突破上限。
- 依赖、显式冲突、路径 glob 有交集时不并行；Spec、锁文件、共享 Manifest/Schema、Migration、Package 和集成默认串行。
- Codex JSONL 实时写入 Git common dir；`thread.started` 到达后立即保存 session ID 和子进程 PID。控制 Session 中断后，只有旧进程确认已退出才允许 `resume`。
- OpenCode 验证与 main 集成分别串行加锁。Verifier 前后比较 worktree Git 状态、任务 plan 目录和用户 plan 目录；任一变化直接 `FAIL`。
- 新 clone 没有本机运行态时，已跟踪的同任务 `PASS` 验证工件会投影为 `ARCHIVED`，避免把已合并 Task 再次派发。
- `workspace-write + approval_policy=never` 的含义是范围内无人工审批、失败直接交回模型；它不是 full access，也不授权外部/生产写入。

## 命令

```bash
# 可选安装/刷新项目使用的 opt-in Codex Profile；不会改已有 yuepu.config.toml
npm run agent-flow -- profiles --install --json
npm run agent-flow -- profiles --check-catalog --json

# Claude 每个 Session 先恢复项目状态，再规划最多五个无冲突 Writer
npm run agent-flow -- validate --json
npm run agent-flow -- status --json
npm run agent-flow -- plan --json

# 单任务生命周期
npm run agent-flow -- dispatch <task-id> --dry-run --json
npm run agent-flow -- dispatch <task-id> --json
npm run agent-flow -- resume <task-id> --json
npm run agent-flow -- verify <task-id> --json
npm run agent-flow -- integrate <task-id> --json
npm run agent-flow -- cleanup <task-id> --json
```

`--dry-run` 只输出受控命令，不启动模型或改状态。真实 `dispatch` 是长运行命令，可以由不同终端/Claude Session 并行启动；不要让两个 Writer 共用 worktree。

Codex 运行在非交互 `exec` 中，范围内不再等用户确认；过程事件由控制器落盘，Claude 只在状态变化、阻塞或最终结果时汇总。因此无需修改 Codex 的系统提示，也不会依赖聊天 Session 的定时进度消息完成任务。

## 文件

- `codex-profiles.json`：V2.2 唯一 Executor Profile 源。
- `agent-flow.schema.json`：Task、运行态与 Verification 合约。
- `executor-result.schema.json`：传给 `codex exec --output-schema` 的严格 Executor 输出合约。
- `task.template.yaml`：Claude 生成任务的模板。
- `tasks/*.yaml`：已批准且可派发的任务定义。
- `verification.template.json`：OpenCode 最终证据形状。
- `verifications/*.json`：冻结 SHA 验收后的审计工件。

确定性门禁：`npm run verify:agent-flow`；仓库最终门禁仍是 `npm run verify`。
