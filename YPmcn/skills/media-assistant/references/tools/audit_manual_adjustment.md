# audit_manual_adjustment

## 何时调用

媒介已明确人工调整且需要留审计记录时调用。

## 输入

必填 `run_id`、`adjustments`、`operator_id`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际记录结果；需要时只读查询 run 详情。

## 错误与停止条件

缺操作者、调整内容或原因时不得写入；未知结果不盲目重试。
