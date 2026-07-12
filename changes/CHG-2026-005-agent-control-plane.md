# CHG-2026-005：建立跨 Session 并行 Agent 控制面

```yaml
task_id: CHG-2026-005
change_type: developer-tooling
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 批准 Claude Code Orchestrator、Codex Executor、OpenCode Verifier 的跨 Session 并行高速开发 Agent 系统方案，并指定三档 Codex 模型白名单"
baseline: "main@0bec372a24f76dbe24f5bae3103b07bf788e4eee"
rollback_strategy: "revert 本变更提交；删除本变更新增的三个用户级 Codex profile 文件"
```

## Problem

仓库已经定义 Claude Code、Codex 与 OpenCode 的职责、Spec 门禁和 Worktree 规则，但当前只有静态任务/验证模板，没有可恢复的任务运行状态、模型路由、路径冲突检查、Codex 非交互派发、OpenCode 只读写入检测和串行集成控制器。多个 Session 只能靠人工记忆衔接，无法稳定并行，也会因审批和重复澄清增加等待。

## Decision

1. Claude Code 是唯一 Orchestrator，拥有任务拆分、依赖图、Profile 选择、Worktree 生命周期、验证派发和串行集成职责，不承担未授权生产实现。
2. Codex 是唯一生产代码 Executor；每个写任务使用独立分支、Worktree 和 Session，在 `workspace-write + approval_policy=never` 下 fail closed，不使用 full access。
3. OpenCode 使用 `yuepu/Deepseek-V4-Pro` 或显式 `yuepu/*` 覆盖，以 `--pure --agent plan` 只读验证冻结的 `base_sha..head_sha`；任何非预期写入直接 `FAIL`。
4. 受版本控制的 Task YAML 是不可变任务定义；高频运行状态写入 Git common dir 下的 `agent-flow/`，从而跨 Worktree/Session 共享且不污染 `main`。最终验证证据仍固化到 `workflows/verifications/`。
5. 根新增单一 `scripts/agent-flow.mjs` 控制器，提供 Profile 安装/检查、任务校验、状态、并行计划、Codex 派发/恢复、OpenCode 验证、串行集成和清理入口。
6. Claude 只能从以下三个大小写敏感白名单 Profile 中选择，不得自由生成模型名或扩大权限：
   - `executor-sol-max-fast`：`gpt-5.6-sol`，`max`，`fast`。
   - `executor-terra-max-fast`：`gpt-5.6-terra`，`max`，`fast`。
   - `executor-terra-medium-fast`：`gpt-5.6-Terra`，`medium`，`fast`。
7. `gpt-5.6-terra` 与 `gpt-5.6-Terra` 按用户输入视为不同模型标识；控制器不得大小写归一化或自动降级。目录拒绝模型时返回 `BLOCKED`。
8. 初始最多两个并行 Codex Writer；Spec、锁文件、共享 Manifest/Schema、Migration、集成和 Package 任务保持串行。
9. 确定性测试是最终技术门禁；模型声明不替代 Git diff、路径边界、命令退出码或仓库全量验证。

## Scope

### Included

- 新增当前任务实例、统一 Agent Flow 状态 Schema、严格 Executor 输出 Schema 与 Codex Profile 白名单。
- 新增单文件 Node.js 控制器及确定性回归测试。
- 扩展 Task/Verification 模板和根 npm 验证入口。
- 更新 Agent、开发者和 Workflows 文档，说明控制面、状态、恢复、并行、验证和集成规则。
- 新增项目级 `CLAUDE.md`，让 Claude Code 每个新 Session 自动进入 Orchestrator 恢复流程。
- 安装并验证三个用户级 Codex Profile 文件。
- 固化 OpenCode 独立验证结果。

### Excluded

- 不修改 `spec/**` 或任何业务契约。
- 不修改 `YPmcn/**`、`vector-mcp/**`、`reference-mcp/**`。
- 不访问生产 provider、数据库、企微、凭据或客户数据。
- 不运行真实 Codex 派发任务作为测试，不消耗模型调用验证控制器逻辑。
- 不自动执行生产写入、Migration、发布、push 或 PR。
- 不修改现有 `/Users/jasper/.codex/yuepu.config.toml`。

## Task Boundary

```yaml
goal: "把已批准的三工具方案实现为可落盘、可恢复、双 Codex Worktree 并行、OpenCode 只读验证和串行集成的确定性控制面"
allowed_paths:
  - "changes/CHG-2026-005-agent-control-plane.md"
  - "changes/CHG-2026-005-agent-control-plane-impact.md"
  - "workflows/**"
  - "scripts/agent-flow.mjs"
  - "scripts/verify.mjs"
  - "tests/agent_flow.test.mjs"
  - "package.json"
  - "package-lock.json"
  - "AGENTS.md"
  - "CLAUDE.md"
  - "README.md"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "docs/AGENT_SPEC_WORKFLOW.md"
  - "docs/DEVELOPER_SPEC_WORKFLOW.md"
  - "docs/integration-readiness.md"
  - "tests/test_skill_package.py"
  - "/Users/jasper/.codex/executor-sol-max-fast.config.toml"
  - "/Users/jasper/.codex/executor-terra-max-fast.config.toml"
  - "/Users/jasper/.codex/executor-terra-medium-fast.config.toml"
forbidden_paths:
  - "spec/**"
  - "YPmcn/**"
  - "vector-mcp/**"
  - "reference-mcp/**"
  - "packages/releases/**"
  - ".github/workflows/**"
  - ".env*"
  - "/Users/jasper/.codex/yuepu.config.toml"
acceptance:
  - "三个大小写敏感 Codex Profile 精确匹配用户指定模型、reasoning=max/max/medium、service_tier=fast、workspace-write 和 approval_policy=never"
  - "Task 定义、运行状态、Executor 输出和 Verification 结果均有机器可检查的字段与状态转换"
  - "控制器能校验依赖、Profile、路径所有权、并发冲突和最多两个 Writer"
  - "控制器能生成并执行受控 codex exec/exec resume 命令，保存 session ID 和 checkpoint，并在越界或目录拒绝模型时 fail closed"
  - "OpenCode 验证固定使用原生 CLI、冻结 SHA、只读 plan agent，并在前后 Git/plan 快照变化时 FAIL"
  - "只有 Executor PASS、Verifier PASS、依赖完成且无冲突的任务才能进入串行集成；全量 verify 失败不得标记 MERGED"
  - "全部离线验证通过，业务 Spec、组件源码、生产系统和发布包源码零变化"
verification:
  - "node --test tests/agent_flow.test.mjs"
  - "npm run verify:agent-flow"
  - "npm run verify"
  - "codex --profile <three profiles> mcp list（离线 Profile 加载）；真实 dispatch 固定 --strict-config"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
  - "OpenCode read-only verification"
rollback: "revert 本变更提交并删除三个新增用户级 Codex profile；Git common dir 下的 agent-flow 运行状态可安全删除，不涉及产品数据"
```

## Implementation Order

1. 提交本 Change Proposal 与 Impact Analysis。
2. 添加失败测试，冻结 Profile、Schema、状态、冲突、命令和 fail-closed 要求。
3. 实现 Agent Flow Schema、白名单、模板和单文件控制器。
4. 接入根脚本与统一离线验证，更新流程文档。
5. 在隔离 CODEX_HOME 中测试 Profile 安装，再安装到真实用户目录并用 Codex strict config 验证。
6. 运行全量门禁，冻结实现提交。
7. 使用 OpenCode 基于冻结 SHA 只读验证；PASS 后串行集成并清理 Worktree。

## Implementation Note — Codex CLI 0.144.1

当前 CLI 的 `features`、`mcp` 和 `debug` 离线子命令会明确拒绝 `--strict-config`，只有 `exec/review` 等模型运行命令接受该开关。为避免为了配置检查发起三次真实模型任务，安装阶段使用 `codex --profile <name> mcp list` 验证三份 Profile 能被原生 CLI 加载，并由确定性测试逐字段校验精确白名单；控制器生成的每次真实 `codex exec` 仍强制包含 `--strict-config`。这不降低运行期门禁，也不探测或归一化模型目录。

## Result — 2026-07-12

```yaml
status: VERIFIED
implementation_sha: "83cbd3417625f8de23f3b905b14d311ea1dbe089"
verifier: "OpenCode / yuepu/Deepseek-V4-Pro / read-only"
verification_result: PASS
unexpected_writes: 0
verification_evidence: "workflows/verifications/CHG-2026-005-AGENT-FLOW.json"
```

- 13 项控制面测试与 191 项仓库离线门禁全部通过；tracked 密钥扫描与 diff 检查为零发现。
- 三份 `0600` 用户级 opt-in Profile 已安装并被当前 Codex CLI 加载，现有 `yuepu.config.toml` 安装前后哈希不变。
- 当前 catalog 精确列出 `gpt-5.6-sol/max` 与 `gpt-5.6-terra/max`；未列出 `gpt-5.6-Terra/medium`。第三档按用户输入保留，catalog 预检会在启动模型前返回 `BLOCKED`，不会纠正大小写或 fallback。
- OpenCode 复跑门禁并检查冻结的 `0bec372..83cbd34`；工作树、项目 plan 目录和用户 plan 目录前后均无变化。
- `spec/**`、业务组件、生产 provider、数据库、CI 和发布包源码零修改。
