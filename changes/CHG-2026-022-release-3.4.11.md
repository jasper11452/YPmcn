# CHG-2026-022：发布 3.4.11 宿主无关手扒回执修复包

```yaml
task_id: CHG-2026-022-RELEASE-3.4.11
change_type: release
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1"
approval_basis: "用户要求小版本更新、提交 Git 并重新打包"
baseline: "3178fe9"
rollback_strategy: "回退本发布提交并重新安装 3.4.10；不覆盖、不删除现有发布包"
```

## Decision

1. 发布版本从 `3.4.10` 升级为 `3.4.11`，统一根 workspace、Plugin、三份 manifest、lockfile 与发布测试。
2. `manual_source_creators` 不再依赖宿主向 `before_tool_call` 注入会话上下文；插件使用自有的一次性交接回执校验紧邻验证产生的精确需求主键，并在首次调用时消费。
3. 发布包由 `npm run pack:yp` 从已验证源码生成，保留既有同名旧版本，不执行生产安装、Provider 写入或远端推送。

## Task Boundary

```yaml
goal: "提交宿主无关手扒回执修复并生成全新 3.4.11 安装包"
allowed_paths:
  - "package*.json"
  - "YPmcn/**"
  - "spec/**"
  - "tests/**"
  - "changes/**"
  - "docs/**"
acceptance:
  - "所有发布版本字段一致为 3.4.11"
  - "缺少 before_tool_call 会话上下文时仍严格校验并单次消费新鲜 requirement_id"
  - "npm run verify 与发布包安全扫描通过"
  - "生成 packages/releases/ypmcn-media-assistant-3.4.11.tgz"
verification:
  - "npm run verify"
  - "npm run pack:yp"
  - "git diff --check"
```

## External Boundary

本次只生成本地安装包和 Git 提交；不推送远端、不安装到生产 Host，也不执行 Provider 业务写入。

## Verification Result

- `npm run verify`：通过；75 项 Plugin 测试、Spec、文档、安全扫描、Provider comparator、Skill 和可复现包测试全部通过。
- `git diff --check`：通过。
- 已生成 `packages/releases/ypmcn-media-assistant-3.4.11.tgz`（123847 bytes，SHA-256 `06882e62fcf0f4383841b174ddddd9ebca773341cbf51e6deaa77322c8d8b8dd`），发布包密钥扫描通过。
- 未推送 Git 远端，未安装生产 Host，未执行 Provider 业务写入。
