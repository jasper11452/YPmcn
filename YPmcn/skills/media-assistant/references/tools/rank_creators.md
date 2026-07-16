# rank_creators

## 何时调用

当前 requirement 已具备候选池/供给报价证据时调用。当前实现不强制这些证据一定来自 MCN 回收。

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

不得发送旧 `mcn_recommendation_id`、`ranking_strategy` 或 `manual_batch_ids`。结果缺 `run_id` 时停止。
