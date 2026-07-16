# sync_mcn_inquiry_status

## 何时调用

当前仅用于登记一次“同步请求元数据”。它尚不能完成真实供应商状态同步。

## 输入

必填 `requirement_id`、`project_id`、`mcn_id`；可选 `cron_job_id`、`scheduled_recover_at`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

不得根据该工具返回推进到“已回收”。等待 MCP 修复后，必须以真实外部状态和 `inquiry_id` 为准。

## 能力边界

当前实现只读写 `mcn_inquiry_status_syncs`，不查询外部供应商项目，不创建或更新 `mcn_inquiries`，也不会提供可供 ingest 使用的可靠 `inquiry_id`。因此现在只是同步任务登记，不是状态对账。

## 错误与停止条件

三个 ID 任一无法由实际证据证明时返回 `integration_required`。未知写结果不盲目重试。
