# CHG-2026-024：发布 3.4.13 手动拓展证据链修正版

```yaml
task_id: CHG-2026-024-RELEASE-3.4.13
change_type: release
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 20"
approval_basis: "用户明确要求插件端立即修正、版本小更新、提交 Git 并打包"
baseline: "12f6fbf"
rollback_strategy: "回退本次提交并重新安装上一版本；不覆盖、不删除既有发布包"
```

## Decision

1. 发布版本统一升级为 `3.4.13`。
2. `manual_source_creators` 只接收 `requirement_id` 与 `size`；其实际成功响应中的唯一非空 `excel_file_path` 是手动拓展及表格导出的终态证据。
3. 手动拓展后不再调用字段选择、`rank_creators` 或 `create_submission_batch`，也不从 callback 或本地状态虚构 `inquiry_id(s)`。
4. `rank_creators.inquiry_ids` 仅允许来自独立 MCN 回收链中本轮 `sync_mcn_inquiry_status` 的实际成功响应。
5. 所有需要用户输入或决策的停顿都必须立即使用宿主弹窗；普通文本不得以等待用户回复的方式停住。

## Task Boundary

```yaml
goal: "修正手动拓展证据链并生成 3.4.13 安装包与 Git 提交"
acceptance:
  - "所有发布版本字段一致为 3.4.13"
  - "手动拓展仅按实际 excel_file_path 完成，不制造 inquiry_id 血缘"
  - "npm run verify 与发布包安全扫描通过"
  - "生成 packages/releases/ypmcn-media-assistant-3.4.13.tgz"
verification:
  - "npm run verify"
  - "npm run pack:yp"
  - "git diff --check"
```

## External Boundary

本次不修改 Provider，不安装到生产 Host，不执行 Provider 业务写入，也不推送 Git 远端。

## Verification Result

- `npm run verify`：通过；80 项 Plugin 测试、25 项 Skill 测试及 Spec、文档、安全、Provider comparator 和发布包测试全部通过。
- `npm run pack:yp`：通过；发布包密钥扫描通过。
- 已生成 `packages/releases/ypmcn-media-assistant-3.4.13.tgz`（125161 bytes，SHA-256 `56569825220dedfe9b60548c1aacf1845c5fcc5288c291ea6df9ac6fa5e8fdba`）。
- `git diff --check`：通过。
- 未修改 Provider，未安装生产 Host，未执行 Provider 业务写入，也未推送 Git 远端。
