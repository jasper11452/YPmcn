# CHG-2026-026：企微外发最近确认直接续发

```yaml
task_id: CHG-2026-026-LAST-APPROVED-EXTERNAL-SEND
change_type: runtime-confirmation-policy-and-patch-release
status: IMPLEMENTED_LOCAL_VERIFIED
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 21"
approval_basis: "用户明确要求取消 create_with_distributions 后续调用的同参校验，改为上一次用户确认发送后直接同意下一次调用，并提交 main、同步 GitHub 与打包"
baseline: "79a78db"
rollback_strategy: "回退本次提交并重新安装 3.4.22；不重放、不删除任何 Provider 写入"
```

## Decision

1. 首次 `create_with_distributions` 仍只在本地创建 `AskUserQuestion` 确认回执，不触达 Provider。
2. 最新的、同一状态作用域内未过期且已精确选择“确认发送”的回执，可授权下一次 `create_with_distributions` 一次；不再将后续调用参数与弹窗前参数的指纹作相等性校验。
3. 保留 10 分钟 TTL、单次消费、会话/无会话隔离、锁保护、取消/拒绝/过期 fail-closed 和 after-tool 发送证据要求。
4. 当续发参数不同，状态仅保存原始与实际执行参数的 SHA-256 指纹和脱敏摘要，避免把消息正文或完整业务 payload 写入本地状态。
5. 补丁版本统一升级为 `3.4.23`；不覆盖、不删除既有 `3.4.22` 发布包。

## Task Boundary

```yaml
goal: "让用户最近一次企微外发确认直接放行下一次调用，消除同参校验导致的跨轮死循环，并发布 3.4.23"
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
  - "changes/CHG-2026-026*"
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
  - "AskUserQuestion 的确认发送回调跨 turn 到达后，后续参数改变的下一次 create_with_distributions 仍可只放行一次"
  - "同一已确认回执不得被第二次发送消费；取消、拒绝、过期、并发和未知写入仍 fail closed"
  - "npm run verify、npm run test:headless、npm run pack:yp 与 git diff --check 通过"
  - "所有发布版本字段为 3.4.23，产物生成在 packages/releases"
verification:
  - "npm --workspace YPmcn run build"
  - "node --test --test-name-pattern='latest approved external-send receipt' YPmcn/tests/native-hooks.test.mjs"
  - "npm run test:headless"
  - "npm run verify"
  - "npm run pack:yp"
  - "git diff --check"
```

## External Boundary

本变更不调用 Provider 业务写入、不发送真实企微消息，也不安装生产 Host。本地验证仅覆盖 Hook 生命周期与发布产物；真实不可逆外发仍须由专用测试环境中的媒介人员明确确认。

## Verification Result

- 实现前，参数变更后的已确认回执仍返回 `EXTERNAL_SEND_CONFIRMATION_REQUIRED`；实现后，目标回归覆盖“预检 → 弹窗 → 下一 turn 确认 → 参数改变后单次外发授权”。
- `npm --workspace YPmcn run build`、目标 Hook 回归与 `npm --workspace YPmcn test`：通过；96 项 Plugin 测试通过。
- `npm run test:headless`：通过；包含 Plugin 测试和 OpenClaw 源码装载检查。
- OpenCode 只读端到端复验：`opencode/laguna-s-2.1-free` 实际运行跨轮参数变化、两类批量转逐机构 fallback、以及成功/未知结果后重新确认的 4 项 Hook 用例，4/4 通过；未改写工作树，未调用 Provider。
- `npm run pack:yp`：通过；其完整离线门禁、密钥扫描和发布包检查均通过。生成 `packages/releases/ypmcn-media-assistant-3.4.23.tgz`（145883 bytes，SHA-256 `ce82a74c54f420b188f69d264522450e55343cc7b0132d03db71734d03a8a43c`）。
- 未调用生产 Provider 业务写入、未发送真实企微消息、未安装生产 Host。
