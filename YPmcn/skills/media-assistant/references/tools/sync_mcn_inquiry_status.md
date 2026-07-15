# sync_mcn_inquiry_status

## 何时调用

分发后的首次对账、回收前对账和 ingest 后收口时调用。

## 输入

必填 `requirement_id`、`project_id`、`mcn_id`；可选 `cron_job_id`、`scheduled_recover_at`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

只按实际状态判断等待、回收或结束；业务阶段不能由健康检查推断。

## 错误与停止条件

三个 ID 任一无法由实际证据证明时返回 `integration_required`。未知写结果不盲目重试。
