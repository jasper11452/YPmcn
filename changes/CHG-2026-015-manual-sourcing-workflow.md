# CHG-2026-015：高风险供给启动手扒

```yaml
task_id: CHG-2026-015-MANUAL-SOURCING
change_type: feature
status: IMPLEMENTED_LOCAL_PROVIDER_BLOCKED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户已确认 manual_source_creators 两字段最小输入方案，并明确要求按优化方案实施、更新版本、提交和打包"
baseline: "67b3f0d7db62ea9c2157875a62c8ad38b4514d9a"
rollback_strategy: "revert 3.3.9 提交并停用新版插件；已由 Provider 创建的真实任务不得删除或伪造回滚"
```

## Problem

当前高风险供给即使供需比为 `6/5 (1.2:1)`，也可能得到补量 `0`，供给确认只会进入 MCN 赛马。`manual_source_creators` 仅接受 `requirement_id`，Skill 将它描述为导入已有人工结果，Hook 又在其成功后错误跳到企微外发准备，因此无法把用户确认的手扒数量传给 Provider，也无法证明手扒任务真的启动。

## Decision

1. 不新增 Agent 可见 Tool；`manual_source_creators` 最小输入固定为 `requirement_id` 与正整数 `target_count`。
2. Tool 的唯一语义调整为创建或幂等复用当前需求的手扒任务。Provider 必须先持久化任务，再返回同一响应对象中的 `task_id`、回显身份与数量、`started|running|completed` 状态、`created|reused` 操作、首次启动时间和已入池数量。
3. Provider 仍未通过 `tools/list` 声明 output schema，因此 Spec 保持 `advertisedOutputSchema=false`；插件将上述字段作为继续执行所需的目标业务证据，缺一项或与请求不一致即 fail closed。
4. 高风险搜索必须使用 Provider 返回的风险、硬缺口、缓冲缺口、正整数建议补量和推荐动作；不得以最低硬缺口 `max(demand-matched, 0)` 覆盖风险缓冲缺口。
5. 供给弹窗提供“启动手扒并开始MCN赛马”“仅开始MCN赛马”“调整手扒数量”。启动分支同轮调用手扒 Tool；调整分支只接受一个正整数。
6. 只有真实任务证据完整时才将下一步设为 `rank_mcns`。`success=true` 但无任务证据、结果未知或字段冲突均进入恢复，绝不宣称已启动，也不盲重试。
7. 供给确认不授权企微外发；手扒启动成功后继续 MCN 赛马，不能直接跳到 `create_with_distributions`。

## Task Boundary

```yaml
goal: "让高风险供给确认把数量准确传给 manual_source_creators，并只凭真实任务证据继续 MCN 赛马"
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
  - "高风险 6/5、建议 4 的确认可生成待执行手扒命令和数量 4"
  - "调整数量只接受单个正整数，取消、超时或非法值不产生执行命令"
  - "完整远程任务证据后进入 rank_mcns；伪成功、字段冲突或未知结果进入恢复"
  - "手扒成功不会进入 create_with_distributions，供给确认不会授权企微外发"
  - "版本更新为 3.3.9，通过完整离线门禁并生成可复核 tgz"
verification:
  - "npm run test:fast"
  - "npm run verify"
  - "npm run pack:yp"
  - "git diff --check"
rollback: "revert 3.3.9 提交；远程任务按真实状态完成、取消或人工处理，不删除审计事实"
```

## External Boundary

本仓库不包含生产 Provider、任务执行器或数据库 migration 源码。本变更能交付并验证插件参数、命令映射、证据门禁和打包契约，但不能用本地测试代替 Provider 任务持久化与隔离 Live E2E。新版插件只能在 Provider 两字段输入和任务证据响应部署后启用真实手扒分支。

## Verification Result

- `npm run verify`：PASS；离线 Spec、Hook、Skill、发布元数据与可复现包测试全部通过。
- `npm run verify:provider`：FAIL（2026-07-20，只读 `initialize` + `tools/list`）。远端仍只要求 `requirement_id`，缺少必填/属性 `target_count`，且 `requirement_id` 未声明目标 `minLength: 1`；远端 schema hash 为 `bc60eb88fafbaf311823e7c71b57ea8744ed53f2a70507fc34bd29a4fb0b9fbd`。
- 结论：本地实现与 3.3.9 包可交付给 Provider 联调，但在远端契约、任务持久化和隔离 Live E2E 通过前保持生产阻断。
