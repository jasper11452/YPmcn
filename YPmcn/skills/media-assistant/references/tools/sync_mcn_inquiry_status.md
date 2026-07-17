# sync_mcn_inquiry_status

## 何时调用

外部项目已创建，需要从真实 distribution 对账机构发送、回填或提交状态时调用。

## 输入

必填 `requirement_id`、`project_id`、`mcn_id`；可选 `cron_job_id`、`scheduled_recover_at`。

## 输出成功证据

- retain actual returned payload as downstream evidence
- 返回真实 distribution 对应的 `inquiry_ids`、`workflow_state` 与 `allowed_actions`

## 调用后必须停在哪里

只依据返回的真实状态与 `inquiry_ids` 决定等待、ingest 或继续同步；没有提交事实时不得声称已回收。

## 能力边界

服务端读取 `core_project/core_distribution`，验证 requirement、project、mcn 归属，并创建或更新 `mcn_inquiries`。它不抓取不存在的回填内容，也不以定时任务元数据替代真实 distribution 状态。

## 错误与停止条件

三个 ID 任一无法由实际证据证明、找不到真实 distribution 或机构不属于该需求时停止。未知写结果不盲目重试，使用 `get_workflow_state` 对账。
