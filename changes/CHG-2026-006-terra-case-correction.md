# CHG-2026-006：修正 Terra Medium Profile 模型大小写

```yaml
task_id: CHG-2026-006
change_type: bugfix-tooling
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 明确说明先前 gpt-5.6-Terra 为笔误，三个模型标识都应使用小写"
baseline: "main@772f7161f2b52123a23d0df02ace58e4f52edac3"
rollback_strategy: "revert 本变更并重新安装上一版三个用户级 Codex Profile"
```

## Problem

`executor-terra-medium-fast` 当前错误配置为 `gpt-5.6-Terra`。Codex catalog 只列出小写 `gpt-5.6-terra`，导致 medium 档被预检为不可用。用户确认这是输入笔误，不是需要保留的独立模型标识。

## Decision

1. `executor-terra-medium-fast` 改为精确的 `gpt-5.6-terra / medium / fast`。
2. `executor-terra-max-fast` 继续使用同一个 `gpt-5.6-terra`，仅 reasoning 为 `max`。
3. `executor-sol-max-fast` 保持 `gpt-5.6-sol / max / fast`。
4. 三档继续固定 `workspace-write + approval_policy=never`；仍禁止白名单外模型和自动 fallback。
5. 更新当前路由文档、控制器硬编码、测试和用户级 opt-in Profile；不改历史 `CHG-2026-005` 验证工件，其内容保留当时事实。
6. 不修改业务 Spec、产品组件、provider、数据库、CI 或发布包源码。

## Task Boundary

```yaml
goal: "把 Terra medium 档从误写的大写模型改为 catalog 中可用的小写 gpt-5.6-terra"
allowed_paths:
  - "changes/CHG-2026-006-terra-case-correction.md"
  - "changes/CHG-2026-006-terra-case-correction-impact.md"
  - "docs/EVOLUTION.md"
  - "AGENTS.md"
  - "CLAUDE.md"
  - "docs/DEVELOPER_SPEC_WORKFLOW.md"
  - "scripts/agent-flow.mjs"
  - "tests/agent_flow.test.mjs"
  - "workflows/README.md"
  - "workflows/codex-profiles.json"
  - "workflows/tasks/CHG-2026-006-TERRA-CASE.yaml"
  - "workflows/verifications/CHG-2026-006-TERRA-CASE.json"
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
  - "两档 Terra Profile 都精确使用小写 gpt-5.6-terra，并分别固定 max 与 medium reasoning"
  - "catalog 检查对三个 Profile 均返回 listed_exactly=true 和 reasoning_supported=true"
  - "用户级 medium Profile 精确同步且现有 yuepu.config.toml 不变化"
  - "控制面测试、191 项仓库门禁和 OpenCode 独立只读验证全部通过"
verification:
  - "node --test tests/agent_flow.test.mjs"
  - "npm run verify"
  - "npm run agent-flow -- profiles --check-catalog --json"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
rollback: "revert 纠错提交并按上一版白名单重装 medium Profile；无业务数据回滚"
```

## Result

首次 OpenCode 复验确认实现、范围、catalog 与 191 项门禁均通过，但把 `commands.result`、`findings` 和 `evidence` 输出成了不符合机器契约的自由结构。控制器按设计判定 `FAIL`，没有接受语义近似结果。纠错任务已在原允许的 `scripts/agent-flow.mjs` 与 `tests/agent_flow.test.mjs` 内收紧 Verifier Prompt 的显式 JSON 形状，保持校验器不变；待第二次独立验证后补充最终结果。
