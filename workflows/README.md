# Workflows

这里存放开发编排模板和角色边界；CI 实现仍在 `.github/workflows/`。当前阶段采用“任务模板 + 确定性门禁 + 独立验证”，不运行会把临时 worktree 当交付目录的常驻控制器。

## 默认角色

| 角色 | 默认工具 | 输出 |
|---|---|---|
| Orchestrator | Claude Code | `goal`、路径边界、验收、验证命令和回滚 |
| Executor | Codex | 有界 diff、自测结果、已知风险和 commit |
| Verifier | OpenCode（不同模型/上下文） | `PASS / FAIL / BLOCKED + evidence`，默认只读 |

使用 `task.template.yaml` 下达任务，使用 `verification.template.json` 固化独立验证结果。强依赖任务按 Spec → Database → MCP → Hook → Skill → Test → Package 串行；只有无文件和契约冲突时才使用多个 worktree。

worktree 是执行期隔离目录。任务合并或归档后，应在确认 clean 且提交已保留后移除。
