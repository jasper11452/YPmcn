# AGENTS.md

## 项目边界

- Git 根目录是唯一长期项目；`YPmcn/`、`vector-mcp/` 和 `reference-mcp/` 是仓库组件。
- 正式契约以 `spec/manifest.json` 指向的 Spec 为准，核心包括 `spec/mcp.json`、`spec/database.json`、`spec/workflow.json` 与 `spec/errors.json`。
- `reference-mcp/` 的模拟结果不是生产证据；生产 provider 使用独立只读检查。
- 安全与数据完整性 > Spec > 测试 > 当前实现 > Agent 推断。
- Python 使用 `uv`，禁止 pip。

## V2.3 极简开发

执行前只确认：

```yaml
goal: "单一结果"
allowed_paths: ["允许修改的路径"]
forbidden_paths: ["禁止修改的路径"]
acceptance: ["可验证完成条件"]
verification: ["最小相关测试"]
```

默认一个写者，不创建任务状态、事件日志或验证证据文件。

- Fast：Claude Code 直接修改、验证、提交。
- Standard：Claude Code 可将一个小任务交给 Codex；Claude Code 最终验收和提交。
- Critical：隔离 worktree、OpenCode 独立只读验证、人工批准外部副作用。

并行不是默认策略。只有 write set 确认不重叠且墙钟收益明确时才使用多个 worktree；即便如此，同一任务仍只有一个写者。

## 修改规则

- 只修改完成目标必需的文件，不顺手重构或弱化测试。
- Bug 修复优先先复现，再最小修复并跑相邻测试。
- 公开 Tool、字段、错误码、权限、迁移或不可逆副作用不明确时 `BLOCKED`，不得自行发明契约。
- 普通文档、测试和内部实现修复不强制创建 Change Proposal 或 Impact Analysis。
- 不直接编辑生成的 `dist/`、`packages/.staging/` 或 tgz。
- 不记录客户 Brief、完整 payload、凭据或未脱敏内部状态。

## 验证

默认：

```text
相关测试
+ git diff --check
+ 修改范围检查
```

仅当风险或失败证据需要时运行一次 `npm run verify`。如需预览或修复自动生成的人类文档，运行 `npm run docs:sync`；提交前可用 `npm run verify:docs` 检查，仓库 `pre-commit` 也会同步相关文档。生产 provider 独立只读检查为 `npm run verify:provider`。

测试未运行必须标记 `NOT RUN`；失败不得描述为通过。

## Token 与重试

- 写 Agent ≤ 1；Verifier ≤ 1。
- 上下文扩展 ≤ 2 次；实现返工 ≤ 2 次；自动重试 ≤ 1 次。
- 不使用 Workflow 处理普通开发、方案调研或代码审查。
- 同类工具故障第二次出现时停止，改走最短可行路径或报告唯一阻塞项。

## 三工具职责

- Claude Code：边界、调度、最终验收和提交。
- Codex：小而明确的实现和自测，不负责最终提交。
- OpenCode：Critical 或明确触发时独立只读验证；禁止写生产文件。

最终报告仅包含结果、改动、验证、风险和 commit。
