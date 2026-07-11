# rank_creators

## 何时调用

最终权威 sync 已返回 recovered，可选人工补量已记录后调用。

## 输入

必填 `mcn_recommendation_id`；可选 `ranking_strategy`、`manual_batch_ids` 按 schema 传。

## 输出成功证据

- success === true
- data.run_id
- data.ranked_count

## 调用后必须停在哪里

进入 `recommendation_ready`，展示精排摘要和风险，再创建提报批次。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。最新 sync 非 recovered、ID 不匹配或结果缺 run_id 时停止。
