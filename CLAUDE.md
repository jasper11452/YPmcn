# YPmcn Claude Code：V2.3 极简流程

本文件与 `.claude/settings.json` 只在从本仓库启动 Claude Code 时生效，不得推广到其他项目。

正式业务契约以 `spec/manifest.json` 指向的 Spec 为准。只有公开接口、权限、数据迁移、副作用语义不明确时才阻塞；普通内部修复不要求额外流程文档。

## 默认流程

```text
确认 goal / allowed_paths / forbidden_paths / acceptance / verification
→ 一个写者完成最小修改
→ 相关测试 + git diff --check
→ Claude Code 最终验收并提交
```

- `fast`：文档、机械修改、明确小修，由 Claude Code 直接完成。
- `standard`：局部功能、Bug、内部重构；Claude Code 可把一个小而明确的实现任务交给 Codex。
- `critical`：认证、权限、迁移、删除、发布、生产配置或不可逆副作用；使用隔离 worktree，并由 OpenCode 独立验证一次，外部副作用需人工批准。

## 硬限制

- 写 Agent 最多 1 个；Verifier 最多 1 个。
- 不为普通开发使用 Workflow、任务状态机、JSONL 或跨 Session 控制器。
- 上下文扩展最多 2 次；实现返工最多 2 次；自动重试最多 1 次。
- Fast 全链路硬上限 15k Token，Standard 50k，Critical 150k。
- 达到预算 80% 后不得新增 Agent、扩大搜索或生成长报告。
- 同类工具故障第二次出现时停止重试，报告唯一阻塞项。

## 三工具职责

- Claude Code：边界、调度、最终验收与提交。
- Codex：仅接小而明确的实现任务，返回 diff、测试结果和风险；不负责最终提交。
- OpenCode：仅在 Critical 或明确触发条件下只读验证，不修改生产文件。

OpenCode 固定使用原生 CLI、`--pure --agent plan`、`yuepu/*` 模型，并在调用前后检查 Git 状态与 plan 目录；出现非预期写入即 FAIL。

## 验证与报告

默认只运行任务相关测试、`git diff --check` 和修改范围检查；风险或失败证据需要时才运行一次全量 `npm run verify`。

最终只报告：

```text
结果：完成 / 阻塞
改动：文件与一句话说明
验证：命令与 PASS / FAIL / NOT RUN
风险：无或具体风险
提交：commit hash 或唯一未提交原因
```

## YPmcn 硬门禁（上下文压缩后仍须生效）

以下规则在 YPmcn 媒介工作流中**任何情况下不得违反**，Hook 会强制阻断违规调用：

1. **跳步阻断**：不得跳过 14 阶段状态机的任何步骤。阶段顺序由 `PreToolUse` hook 强制执行。
2. **发送前三项确认**：`create_with_distributions` 前必须完成 supply/MCN/message 三项确认，通过 `confirm_distribution_send` session action 写入。缺任一项 hook 返回 `CONFIRMATION_REQUIRED`。
3. **终态锁**：`recovered`/`closed` 后禁止重复写入。hook 返回 `RECOVERY_ALREADY_TERMINAL`。
4. **不模拟成功**：只有实际 MCP 返回算证据，不得用预期返回或示例 JSON 冒充运行结果。
5. **ID 不发明**：下游 ID 无法从实际返回证明时，停止并返回 `integration_required`。
6. **Bash 不绕过**：禁止通过 shell/curl/powershell 直接调用 provider 写 API。Hook 返回 `INTEGRATION_REQUIRED`。
