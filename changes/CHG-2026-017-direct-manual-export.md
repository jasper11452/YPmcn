# CHG-2026-017：字段选择后直接拓展达人并导出

```yaml
task_id: CHG-2026-017-DIRECT-MANUAL-EXPORT
change_type: workflow-and-tool-contract
status: IMPLEMENTED_LOCAL_PROVIDER_BLOCKED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户明确指定字段选择 → 拓展达人 → 筛选去重 → 批次导出的调用顺序及导出参数"
baseline: "97c901b"
rollback_strategy: "回退本变更；远程已产生的拓展达人、排序或导出事实只按 Provider 权威状态处置"
```

## Decision

1. 拓展达人导出链的第一个业务 Tool 固定为 `select_inquiry_form_fields`，由其打开网页并等待字段选择。
2. 字段选择完成后，使用同一需求的 `requirement_id` 与正整数十进制字符串 `size` 调用 `manual_source_creators`。
3. 只把拓展达人成功响应实际返回的 `inquiry_ids` 交给 `rank_creators` 做筛选与去重；同时沿用当前需求和已选字段。
4. 排序成功后立即调用 `create_submission_batch` 导出表格；入参固定为 `requirement_id`、同一 `size` 和正整数十进制字符串批次号 `number`。
5. 不再用 `target_count` 调用拓展达人，也不再用 `run_id` 调用本链的批次导出。

## Task Boundary

```yaml
goal: "把拓展达人导出收敛为字段选择、拓展达人、筛选去重、批次导出四步链路"
allowed_paths:
  - "changes/CHG-2026-017-direct-manual-export*.md"
  - "spec/**"
  - "YPmcn/src/**"
  - "YPmcn/tests/**"
  - "YPmcn/skills/media-assistant/**"
  - "YPmcn/README.md"
  - "tests/**"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
forbidden_paths:
  - ".env*"
  - "packages/.staging/**"
  - "packages/releases/**"
acceptance:
  - "Agent 的四个业务 Tool 严格按字段选择、拓展达人、筛选去重、批次导出执行"
  - "manual_source_creators 只接受 requirement_id 与 size"
  - "rank_creators 使用拓展达人实际返回的 inquiry_ids，并沿用需求与字段"
  - "create_submission_batch 只接受 requirement_id、size、number"
  - "本地契约、Skill、运行时提示与测试一致"
verification:
  - "npm run test:fast"
  - "npm run verify"
  - "npm run verify:provider:prod"
  - "git diff --check"
rollback: "回退本变更文件；不得删除或伪造远程业务事实"
```

## External Boundary

2026-07-21 的只读 `tools/list` 已证明字段选择、拓展达人和排序的新输入形状；`create_submission_batch(requirement_id,size,number)` 尚未部署。离线实现不能替代 Provider 发布证据，生产导出在远端契约对齐前保持 `integration_required`。

## Verification Result

- `npm run test:fast`：通过，65 项测试通过。
- `npm run verify`：通过，Spec、文档、插件、Skill、包内容和安全门禁全部通过。
- `skill-creator/scripts/quick_validate.py`：通过。
- `npm run verify:provider:prod`：按预期失败；字段选择、拓展达人和排序已对齐，生产 `create_submission_batch` 仍要求旧 `run_id`。比较器同时继续报告本任务范围外既存的 `create_with_distributions` 与 `get_workflow_state` 漂移。
- `git diff --check`：通过。
