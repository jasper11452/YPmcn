# CHG-2026-025：企微外发确认跨轮回执

```yaml
task_id: CHG-2026-025-EXTERNAL-SEND-CROSS-TURN
change_type: runtime-orchestration-and-patch-release
status: IMPLEMENTED_LOCAL_VERIFIED
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 21"
approval_basis: "用户明确要求修复 create_with_distributions 的跨轮确认死循环、执行 OpenCode 端到端验证、更新补丁版本、提交 main、同步 GitHub 并打包"
baseline: "18e079c"
rollback_strategy: "回退本次提交并重新安装上一补丁包；不重放、不删除任何 Provider 写入"
```

## Decision

1. `create_with_distributions` 的首次本地预检继续不触达 Provider，只创建按会话、参数指纹和 10 分钟 TTL 绑定的一次性本地回执。
2. `AskUserQuestion` 的用户结果允许在后续 assistant turn 到达；到达后消费原回执并只放行一次完全相同的参数，不因 turn 边界重新创建确认或 nonce。
3. 原生弹窗的 JSON 参数保持原样；本地状态只保存脱敏指纹、摘要和生命周期时间，不保存消息正文或完整业务 payload。
4. 补丁版本统一升级为 `3.4.22`，通过离线验证、OpenCode 独立端到端回归、打包、提交到 `main` 与 GitHub 同步后交付。

## Task Boundary

```yaml
goal: "消除企微外发确认的跨轮 nonce/回执死循环，并发布 3.4.22"
allowed_paths:
  - "YPmcn/src/runtime-hook-workflow.ts"
  - "YPmcn/src/index.ts"
  - "YPmcn/skills/media-assistant/**"
  - "YPmcn/tests/native-hooks.test.mjs"
  - "spec/skills.json"
  - "spec/workflow.json"
  - "spec/hooks.json"
  - "tests/spec_governance.test.mjs"
  - "tests/package_release.test.mjs"
  - "package*.json"
  - "YPmcn/package*.json"
  - "YPmcn/.codex-plugin/plugin.json"
  - "YPmcn/.claude-plugin/plugin.json"
  - "YPmcn/openclaw.plugin.json"
  - "changes/CHG-2026-025*"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "docs/integration-readiness.md"
  - "docs/高效联调测试指南.md"
  - "YPmcn/README.md"
forbidden_paths:
  - "remote Provider data"
  - ".env*"
  - "production Host configuration"
acceptance:
  - "同一会话中，AskUserQuestion 回调跨 turn 到达后，首次回执仍可精确授权一次同参 create_with_distributions"
  - "待确认时重复尝试复用同一回执和同一弹窗，不生成新 nonce"
  - "取消、超时、参数变化、回执过期、并发或未知写入仍 fail closed"
  - "npm run verify、OpenCode 端到端回归、npm run pack:yp 和 git diff --check 通过"
  - "所有发布版本字段为 3.4.22，产物生成在 packages/releases"
verification:
  - "npm --workspace YPmcn test"
  - "npm run test:headless"
  - "npm run verify"
  - "OpenCode read-only end-to-end lifecycle verification"
  - "npm run pack:yp"
  - "git diff --check"
```

## External Boundary

本变更不调用 Provider 业务写入、不发送真实企微消息，也不安装生产 Host。OpenCode 验证仅运行本地 Hook 生命周期回归；真实不可逆外发仍须由专用测试环境中的媒介人员明确确认。

## Verification Result

- 跨轮回归先以旧行为失败（缺少后续 turn 回执说明），实现后通过：首次预检、后续用户回调、同回执单次同参放行均由 `native-hooks.test.mjs` 覆盖。
- 合并最新 `main` 后的 `npm run test:headless`：通过；96 项 Plugin 测试和 OpenClaw 源码装载冒烟均通过。
- OpenCode 只读端到端核验：使用 `opencode/laguna-s-2.1-free` 在合并后的代码上实际执行跨轮生命周期测试，通过（1 pass、0 fail）；未改写工作树，未调用 Provider。
- 合并最新 `main` 后的 `npm run verify`：通过；96 项 Plugin 测试，以及 Spec、文档、密钥、Provider comparator、Skill 和发布包检查均通过。
- `npm run pack:yp`：通过；生成 `packages/releases/ypmcn-media-assistant-3.4.22.tgz`（145589 bytes，SHA-256 `1d304b18594cb0c583199332e6232d20f1f8edf32e00002c8219a9289b290164`），打包后密钥扫描通过。
- 未调用生产 Provider 业务写入、未发送真实企微消息、未安装生产 Host。
