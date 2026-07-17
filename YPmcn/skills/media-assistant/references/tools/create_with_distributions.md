# create_with_distributions

## 何时调用

供需、目标 MCN、消息和字段准备完成，且 `get_workflow_state` 允许外发时调用；这是不可逆的外部项目与分发写入。

## 输入

必填 `projectName`、`deadline`、`columns`、`supplierIds`、`prefillRows`、`prefillRowsBySupplier`；可选 `description`、`usageScope`。

## 输出成功证据

- retain actual returned payload as downstream evidence
- `success=true`，并返回可对账的项目或 distribution 身份
- 返回更新后的 `workflow_state` 与 `allowed_actions`

## 调用后必须停在哪里

首次调用会被 Hook 返回 `YP_CONFIRMATION_REQUIRED`。使用 Ask 完成一次性确认后，以完全相同参数重试。成功后按返回身份调用 sync；结果未知则先 `get_workflow_state`。

## 能力边界

MCP 必须从 supplier 和 prefill 行反查唯一需求，写 Ledger，并把真实 project/distribution 镜像为 `mcn_inquiries`。身份无法唯一确定时 fail closed。

## 错误与停止条件

不得发送旧 `mcn_recommendation_id`、`remindAt`、`sendWechatNotification` 或 `preview_only`。Ask 修改、Reject、超时、参数变化或写结果未知时不得发送。
