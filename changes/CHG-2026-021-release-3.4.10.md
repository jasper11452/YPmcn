# CHG-2026-021：发布 3.4.10 Human-in-the-loop 修复包

```yaml
task_id: CHG-2026-021-RELEASE-3.4.10
change_type: release
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1"
approval_basis: "用户要求提交当前修复并重新打包；仓库发布规范要求新包递增 patch 版本"
baseline: "e5bca71"
rollback_strategy: "回退本发布提交并重新安装 3.4.9；不覆盖、不删除现有发布包"
```

## Decision

1. 发布版本从 `3.4.9` 升级为 `3.4.10`，统一根 workspace、Plugin、三份 manifest、lockfile 与发布测试。
2. `3.4.9` 的旧搜索供给响应兼容按既定期限结束；`3.4.10` 只消费 `total_matched + supply_assessment`，旧三字段响应进入证据恢复分支。
3. 发布包由 `npm run pack:yp` 从已验证源码生成，保留既有同名旧版本，不执行生产安装、Provider 写入或远端推送。

## Task Boundary

```yaml
goal: "提交 Human-in-the-loop 修复并生成全新 3.4.10 安装包"
allowed_paths:
  - "package*.json"
  - "YPmcn/package*.json"
  - "YPmcn/.claude-plugin/plugin.json"
  - "YPmcn/.codex-plugin/plugin.json"
  - "YPmcn/openclaw.plugin.json"
  - "YPmcn/src/contract/loader.ts"
  - "YPmcn/src/runtime-hook-workflow.ts"
  - "YPmcn/tests/**"
  - "YPmcn/skills/media-assistant/references/tools/search_creators.json"
  - "spec/**"
  - "tests/**"
  - "changes/CHG-2026-019*"
  - "changes/CHG-2026-021*"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
acceptance:
  - "所有发布版本字段一致为 3.4.10"
  - "旧搜索响应不再形成有效供给证据"
  - "npm run verify 与发布包安全扫描通过"
  - "生成 packages/releases/ypmcn-media-assistant-3.4.10.tgz"
verification:
  - "npm run verify"
  - "npm run pack:yp"
  - "git diff --check"
```

## External Boundary

本次只生成本地安装包和 Git 提交；不推送远端、不安装到生产 Host，也不执行任何 Provider 业务写入。

## Verification Result

- `npm run verify`：通过；75 项 Plugin 测试、Spec、文档、安全扫描、Provider comparator、Skill 和可复现包测试全部通过。
- `git diff --check`：通过。
- 已生成 `packages/releases/ypmcn-media-assistant-3.4.10.tgz`（122750 bytes，SHA-256 `cce0b03133fc306e7312d9a32801fa6828b4577ff58991c2f97df290e65bfa83`），发布包密钥扫描通过。
- 未推送 Git 远端，未安装生产 Host，未执行 Provider 业务写入。
