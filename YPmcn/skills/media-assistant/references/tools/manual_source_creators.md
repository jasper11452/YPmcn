# manual_source_creators

## 何时调用

供给不足、MCN 覆盖不足、媒介要求手扒补量，或数据库缺真实资源字段需要人工补充时调用。

**精确触发条件**（满足任一即可）：
1. `search_creators` 返回候选池数量不满足需求倍数（如需求 10 人，候选池仅 8 人）。
2. `rank_mcns` 返回合格 MCN 少于 5 家且覆盖率不足，已预警媒介。
3. 媒介在 `confirm-supply-ratio` 弹窗中选择「全手扒」或「补充手扒」。
4. 媒介在 `insufficient-supply` 弹窗中选择「手工补量」。

**调用前必须**：已获得 `demand_id` 和 `demand_version`（来自 `validate_requirement` 成功响应）。

## 输入

必填 `demand_id`、`demand_version`。可选 `search_context` 和 `manual_results` 按运行时 schema 传入。

## 输出成功证据

导入汇总、重复项、创建或更新的候选/offer 结果，以及哪些账号可进入后续推荐。

## 调用后流程影响

导入手扒结果后：
1. 展示补量结果（新增数量、重复项、仍缺字段）。
2. **必须重新调用 `search_creators`** 将手扒结果纳入候选池，确保后续 `rank_mcns` 和 `rank_creators` 覆盖完整候选。
3. 重新 `search_creators` 后，按正常流程继续：筛选口径确认 → `rank_mcns` → 比例/名单/表单确认。

## 调用后必须停在哪里

导入后展示补量结果和仍缺字段，必要时回到供给确认或数据字段确认，不得自动跳过 MCN/表单/发送 gate。

## 禁止

不得用虚拟账号、虚拟报价或无来源账号补量。没有有效 offer 的手扒结果不得直接进入客户推荐或提报。
