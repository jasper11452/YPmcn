# CHG-2026-023：发布 3.4.12 工具链路与状态机加固包

```yaml
task_id: CHG-2026-023-RELEASE-3.4.12
change_type: release
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 20"
approval_basis: "用户要求版本小更新并打包"
baseline: "12f6fbf"
rollback_strategy: "回退本发布变更并重新安装 3.4.11；不覆盖、不删除现有发布包"
```

## Decision

1. 发布版本从 `3.4.11` 升级为 `3.4.12`，统一根 workspace、Plugin、三份 manifest、lockfile 与发布测试。
2. 发布内容包括导出主链运行时顺序门禁、字段和 ID 血缘校验、业务成功证据校验、未知写结果对账状态，以及 OpenCode 风格工具名和会话标识兼容。
3. 发布包由 `npm run pack:yp` 从已验证源码生成，保留既有同名旧版本，不执行生产安装、Provider 写入或远端推送。

## Task Boundary

```yaml
goal: "发布工具调用与状态机加固并生成全新 3.4.12 安装包"
allowed_paths:
  - "package*.json"
  - "YPmcn/package*.json"
  - "YPmcn/.claude-plugin/plugin.json"
  - "YPmcn/.codex-plugin/plugin.json"
  - "YPmcn/openclaw.plugin.json"
  - "tests/package_release.test.mjs"
  - "changes/CHG-2026-023*"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
acceptance:
  - "所有发布版本字段一致为 3.4.12"
  - "npm run verify 与发布包安全扫描通过"
  - "生成 packages/releases/ypmcn-media-assistant-3.4.12.tgz"
verification:
  - "npm run verify"
  - "npm run pack:yp"
  - "git diff --check"
```

## External Boundary

本次只生成本地安装包；不推送 Git 远端、不安装生产 Host，也不执行 Provider 业务写入。

## Verification Result

- `npm run verify`：通过；79 项 Plugin 测试、Spec、文档、安全扫描、Provider comparator、Skill 和可复现包测试全部通过。
- `git diff --check`：通过。
- 已生成 `packages/releases/ypmcn-media-assistant-3.4.12.tgz`（125897 bytes，SHA-256 `2e261407e9b8bb606a280f6594cb723c5e6c21e582a5b7fae55be4d6c09731cf`），发布包密钥扫描通过。
- 包内 `package.json`、Codex manifest 均为 `3.4.12`，初始状态 schema 为 v20。
- 未推送 Git 远端，未安装生产 Host，未执行 Provider 业务写入。
