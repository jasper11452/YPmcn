# sync_mcn_inquiry_status

## 何时调用

外部项目已创建，需要从真实 distribution 对账机构发送、回填或提交状态时调用。

## 输入

必填 `requirement_id`、`project_id`、`mcn_id`；可选 `cron_job_id`、`scheduled_recover_at`。

## 输出成功证据

- retain actual returned payload as downstream evidence
- 只有实际查询真实 distribution，并返回对应 `inquiry`、`recovery_context`、`workflow_state` 与 `allowed_actions`，才算权威同步证据

## 调用后必须停在哪里

只依据返回的真实状态与 `inquiry_ids` 决定等待、ingest 或继续同步；没有提交事实时不得声称已回收。

## 能力边界

当前远程开发进程尚未复核，不能假定其已经具备权威同步；独立待部署后端源码已不再是“只记元数据”的旧实现。

本 Tool 应独占 inquiry 写入：按 `core_distribution` 已有 `(project_id,supplier_id)` 唯一键查询真实分发和最新 notification，并把 `supplier_id` 与当前需求、平台下的 `mcn_recommendation_items.mcn_id` 精确绑定。在一个本地事务中按 `mcn_recommendation_item_id + attempt_no` 现有唯一键 upsert `mcn_inquiries`：同一项目重复同步更新同一 attempt；同一推荐项进入新项目时才创建递增 attempt。发送/提交时间、`row_count` 和状态只映射到真实存在的字段；`mcn_inquiry_status_syncs` 只更新最后同步元数据。成功返回的 `recovery_context` 必须同时包含 `recovery_id`、`sync_id`、`project_id`、`distribution_id`、`mcn_id`、`inquiry_id` 与 `attempt_no`。真实表没有 `returned_at` 或 provider version 列，不得发明；重复读取相同 distribution 快照必须返回同一个 `inquiry_id`。待部署源码已实现这一路径，但未取得远程真实写证据前不得宣称线上已生效。

## 错误与停止条件

三个 ID 任一无法由实际证据证明、找不到真实 distribution 或机构不属于该需求时停止。未知写结果不盲目重试，使用 `get_workflow_state` 对账。
