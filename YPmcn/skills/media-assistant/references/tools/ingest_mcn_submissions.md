# ingest_mcn_submissions

## 何时调用

已有当前 inquiry 和真实回收条目时调用。

## 输入

必填 `inquiry_id`、`items`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

保存实际 ingest 结果，再执行最终 sync；此时不能直接精排。

## 能力边界

只摄取已有真实回收条目；不负责向供应商采集、催收或确认数据真实性。来源、缺失值和风险必须原样保留供后续复核。

## 错误与停止条件

不得发送旧 `mcn_recommendation_id`、`requirement_id`、`trigger` 形态。缺 inquiry 证据或 items 时停止。
