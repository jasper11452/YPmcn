# create_with_distributions

## 何时调用

供需、目标 MCN、消息和字段均已确认，且 Hook 持有当前会话证据时调用。它是唯一 provider 项目/分发/企微写入口。

## 输入

必填 `mcn_recommendation_id`、`projectName`、`description`、`deadline`、`remindAt`、`usageScope`、`supplierIds`、`columns`、`sendWechatNotification`、`preview_only`。固定 `usageScope=project`、`preview_only=false`；columns 必须等于字段选择 items。

## 输出成功证据

- success === true
- data.provider_project_id
- data.distribution_batch_ref
- data.distributions.length > 0

## 调用后必须停在哪里

只进入 `distribution_sync_pending`，立即用两个语义 ID 做首次 sync；不能直接宣布等待。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。缺 `sessionKey`、`toolCallId`、由 `confirm_distribution_send` session action 绑定到当前推荐的角色/三项确认、未来时间或字段证明时阻断。写结果未知只对账，不重复创建。
