# rank_creators

## 何时调用

仅当真实企微外发已成功、全部活动平台回收完成、权威 phase 为 `candidate_pool_enriched`，且 `allowed_actions` 明确包含 `rank_creators` 时调用。手扒结果、候选池或供给报价不能单独满足此前置条件。

## 输入

必填 `requirement_id`、`limit`。

## 输出成功证据

- provider description advertises run_id
- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

保存实际返回的 `run_id`，再决定是否创建提报批次。

## 能力边界

当前实现读取候选池、供给关系、平台达人表和 MCN 推荐，写 `recommendation_runs`、`creator_recommendation_items`。硬筛不可被软特征覆盖；必须保留缺失值、来源和推荐解释。

## 错误与停止条件

未同时取得企微外发成功与回收完成证据时停止。不得发送旧 `mcn_recommendation_id`、`ranking_strategy` 或 `manual_batch_ids`。结果缺 `run_id` 时停止。
