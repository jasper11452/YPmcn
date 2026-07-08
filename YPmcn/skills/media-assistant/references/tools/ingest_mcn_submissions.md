# ingest_mcn_submissions

## 何时调用

MCN 已回填达人、报价、档期或数据指标，且存在真实 `inquiry_id` 时调用。

## `inquiry_id` 来源

`inquiry_id` 由 `create_with_distributions` 成功发送企微询价后产生，可通过以下方式获取：

1. **`get_recommendation_run_detail`**：调用时传入 `run_id`（来自 `rank_creators`），返回结果中包含与该推荐运行关联的 `inquiry_ids`。
2. **`create_with_distributions` 响应**：分发成功后的响应数据中直接返回 `inquiry_id` 或 `inquiry_ids`。

`inquiry_id` 只能来自上述真实来源，不得由 Agent 构造或推断。如果无法获取有效 `inquiry_id`，说明 MCN 回填尚未完成或询价未成功发送，不得调用本工具。

## 输入

必填 `inquiry_id` 和 `items`。`items` 必须来自真实 MCN 回填，不得由 Agent 补造。

## 输出成功证据

接受/拒绝明细、回填汇总、创建或更新的 offer、候选池写入结果。

## 调用后必须停在哪里

展示回填有效性和缺失字段；如仍不足，停在补量/放宽/等待更多回填。回填满足后才允许进入精排确认。

## 禁止

不得直接写推荐池。不得跳过回填导入直接 `rank_creators`。不得把无报价、无账号 ID 或无法识别主页链接的记录当作有效供给。
