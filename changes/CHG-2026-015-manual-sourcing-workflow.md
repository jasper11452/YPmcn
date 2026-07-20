# CHG-2026-015：高风险供给启动达人拓展

```yaml
task_id: CHG-2026-015-MANUAL-SOURCING
change_type: feature
status: IMPLEMENTED_LOCAL_PROVIDER_BLOCKED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户确认达人拓展必须先有 inquiry 关联，并明确要求先调用 rank_mcns 生成 inquiry_id，再调用达人拓展 Tool"
baseline: "67b3f0d7db62ea9c2157875a62c8ad38b4514d9a"
rollback_strategy: "revert 3.4.0 提交并停用新版插件；已由 Provider 创建的真实任务不得删除或伪造回滚"
```

## Problem

当前高风险供给即使供需比为 `6/5 (1.2:1)`，也可能得到补量 `0`。直接用 `requirement_id` 调用 `manual_source_creators` 已实际返回 `INQUIRY_NOT_FOUND`，说明达人拓展必须先关联询价；原流程却先启动达人拓展、后执行 `rank_mcns`，顺序与 Provider 前置条件相反。同时，现网一字段 Tool 无法表达用户确认的补量数量，普通 `success=true` 也不能证明任务真的启动。

## Decision

1. 不新增 Agent 可见 Tool；`manual_source_creators` 最小输入固定为 `requirement_id` 与正整数 `target_count`。
2. 高风险供给确认只保存补量命令；实际执行必须先调用 `rank_mcns`，由它为同一需求持久化询价关联并返回真实 `inquiry_id`。缺少该证据时不得调用达人拓展。
3. `inquiry_id` 是服务端关联证据，不新增为 `manual_source_creators` 入参。达人拓展 Tool 创建或幂等复用询价关联任务，并在同一响应记录中回显相同 `inquiry_id`、`task_id`、需求与数量、允许状态/操作、首次启动时间和已入池数量。
4. Provider 仍未通过 `tools/list` 声明 output schema，因此 Spec 保持 `advertisedOutputSchema=false`；插件将 `rank_mcns.inquiry_id` 与上述任务字段作为继续执行所需的目标业务证据，缺一项或关联冲突即 fail closed。
5. 高风险搜索必须使用 Provider 返回的风险、硬缺口、缓冲缺口、正整数建议补量和推荐动作；不得以最低硬缺口 `max(demand-matched, 0)` 覆盖风险缓冲缺口。
6. 供给弹窗提供“启动达人拓展并开始MCN排序”“仅开始MCN排序”“调整达人拓展数量”。启动与调整分支都先进入 `rank_mcns`；只有拿到 `inquiry_id` 才同轮调用达人拓展 Tool。
7. 达人拓展真实任务证据完整后进入 MCN 确认。`success=true` 但无询价/任务证据、结果未知或字段冲突均进入恢复，绝不宣称已启动，也不盲重试。
8. 供给确认不授权企微外发；达人拓展成功不能直接跳到 `create_with_distributions`。

## Task Boundary

```yaml
goal: "让高风险供给先由 rank_mcns 建立 inquiry 关联，再把确认数量传给 manual_source_creators，并只凭匹配的询价与任务证据进入 MCN 确认"
allowed_paths:
  - "changes/CHG-2026-015-manual-sourcing-workflow*.md"
  - "spec/mcp.json"
  - "spec/database.json"
  - "spec/skills.json"
  - "spec/workflow.json"
  - "YPmcn/src/**"
  - "YPmcn/dist/**"
  - "YPmcn/tests/**"
  - "YPmcn/skills/media-assistant/**"
  - "YPmcn/README.md"
  - "docs/MANUAL_SOURCING_WORKFLOW_OPTIMIZATION_PLAN.md"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "tests/**"
  - "package.json"
  - "package-lock.json"
  - "YPmcn/package.json"
  - "YPmcn/package-lock.json"
  - "YPmcn/openclaw.plugin.json"
forbidden_paths:
  - ".env*"
  - "packages/.staging/**"
  - "packages/releases/**"
acceptance:
  - "Tool 公开输入严格为 requirement_id 与 target_count，数量必须为正整数"
  - "高风险 6/5、建议 4 的确认先生成 rank_mcns 命令并保留待执行达人拓展数量 4"
  - "调整数量只接受单个正整数，取消、超时或非法值不产生执行命令"
  - "rank_mcns 缺 inquiry_id 时不调用达人拓展；完整且匹配的远程任务证据后进入 MCN 确认"
  - "达人拓展成功不会进入 create_with_distributions，供给确认不会授权企微外发"
  - "版本更新为 3.4.0，通过完整离线门禁并生成可复核 tgz"
verification:
  - "npm run test:fast"
  - "npm run verify"
  - "npm run pack:yp"
  - "git diff --check"
rollback: "revert 3.4.0 提交；远程任务按真实状态完成、取消或人工处理，不删除审计事实"
```

## External Boundary

本仓库不包含生产 Provider、任务执行器或数据库 migration 源码。本变更能交付并验证插件参数、命令映射、证据门禁和打包契约，但不能用本地测试代替 `rank_mcns` 询价持久化、Provider 任务持久化与隔离 Live E2E。新版插件只能在 `rank_mcns` 返回真实 `inquiry_id`、Provider 两字段输入和询价关联任务证据响应均部署后启用真实达人拓展分支。

## Verification Result

- `npm run verify`：PASS；离线 Spec、Hook、Skill、发布元数据与可复现包测试全部通过。
- `npm run verify:provider`：FAIL（2026-07-20，只读 `initialize` + `tools/list`）。远端仍只要求 `requirement_id`，缺少必填/属性 `target_count`，且 `requirement_id` 未声明目标 `minLength: 1`；远端 schema hash 为 `bc60eb88fafbaf311823e7c71b57ea8744ed53f2a70507fc34bd29a4fb0b9fbd`。
- `rank_mcns.inquiry_id` 属于未广告输出，`tools/list` 无法证明远端已实现；必须由 Provider 集成测试和隔离写入 E2E 验证。
- 结论：本地实现可交付给 Provider 联调，但在远端输入契约、询价关联、任务持久化和隔离 Live E2E 通过前保持生产阻断。
