# CHG-2026-016 Impact Analysis

```yaml
task_id: CHG-2026-016-POST-RACE-MANUAL-SOURCING
status: IMPLEMENTED_LOCAL_PROVIDER_BLOCKED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
runtime_scope: "local plugin, packaged Skill, target MCP output evidence"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Algorithm | 批准刊例倍率、已选机构覆盖倍率、20/30 风险边界和 `<20` 缺口公式 | 比较原始整数，不用展示舍入值判档。 |
| Search evidence | 赛马前只读取需求数、刊例资源数和刊例倍率 | 不接受赛前精确拓展达人数或 MCN/拓展达人比例作为决策证据。 |
| Rank evidence | 增加实际已选机构集合、去重并集覆盖、倍率、风险与条件性精确缺口 | Provider 必须按 `(platform, kwUid)` 去重并把结果绑定同一次询价。 |
| Workflow | 精确数量确认由 search 后移动到 rank 成功后 | `<20` 才显示一键补量；`≥20` 不保存精确建议。 |
| Hook state | 分离 `pre_race_*` 与 `post_race_*` 字段，并把外发对象绑定到覆盖计算集合 | 旧状态迁移时清除赛前待执行精确数量。 |
| Skill / Prompt | 改写展示、弹窗选项和连续执行顺序 | 赛前不得出现“建议拓展达人 N 位”。 |
| Provider / DB | 需要可审计的已选机构集合和覆盖并集计算版本 | 本仓库只能声明目标证据，不能证明生产实现。 |
| Tests / package | 增加 19.8、20、29.8、30 倍边界和一键补量回放 | 不调用生产写 Tool。 |

## Compatibility And Rollout

- `manual_source_creators` 的两字段输入不变，但 `target_count` 的授权来源改为赛后公式结果。
- `search_creators` 不再需要 3.4.1 的赛前补量、MCN 覆盖及比例目标字段。
- `rank_mcns` 新增未广告的目标输出证据；远端缺失任一字段时本地状态不得进入赛后补量或外发。
- 机构集合一旦变化，必须重新运行权威覆盖计算；旧倍率和缺口不能复用。
- 插件回滚不会取消、删除或重复启动已经由 Provider 创建的任务。

## Security And Data

- Hook 仅保存已选机构 ID 的 SHA-256、覆盖汇总和任务最小投影，不保存达人身份集合或客户 Brief。
- 用户界面只显示机构名和数量，不显示供应商、询价或任务 ID。
- 一键补量与不可逆企微外发继续使用独立确认，不共享授权。

## Verification

先以 Hook 回放验证边界、公式、状态迁移和机构集合绑定，再执行完整离线门禁。生产可用性仍要求 Provider 仓库的去重单元测试、持久化/并发测试、只读契约对齐和隔离 Live E2E。

本地 `npm run verify`、`npm run test:openclaw` 与 `git diff --check` 均已通过；该结果不替代生产 Provider 验证。
