# rank_mcns

## 何时调用

已有当前候选标识，需要形成 MCN 建议时调用。

## 输入

必填 `id`、`platform`；`minimum_mcn_count`、`target_multiplier`、`buffer_rate`、`medium_risk_confirmed`、`medium_risk_confirmation`、`limit`、`write_mcn_recommendation_items` 可选。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示 MCN 建议并等待人工确认。

## 能力边界

这是目标 Provider 契约；当前排序权重、阈值和真实供应商数据未获生产验收。返回建议必须展示供给缺口和风险，不能表述成确定可交付量。

## 错误与停止条件

不得把旧 `candidate_pool_id` 字段发给 provider，也不得为凑数量暗自放宽条件。
