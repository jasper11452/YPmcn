# rank_mcns

## 何时调用

已有当前候选标识，需要形成 MCN 建议时调用。

## 输入

必填 `id`、`platform`；`minimum_mcn_count`、`target_multiplier`、`buffer_rate`、`medium_risk_confirmed`、`medium_risk_confirmation`、`limit`、`write_mcn_recommendation_items` 可选。

## 输出成功证据

- `success === true`
- 实际返回 `data.mcn_run_id`
- 实际 MCN 列表和缺口信息原样保留
- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示 MCN 建议并等待人工确认。

## 能力边界

当前实现读取需求、候选池、供给关系和 `core_supplier`，写入 `mcn_recommendation_items`。开发库 `mcn_agencies` 为空，机构身份实际来自 `core_supplier`。返回建议必须展示供给缺口和风险。

## 错误与停止条件

不得把旧 `candidate_pool_id` 字段发给 provider，也不得为凑数量暗自放宽条件。
