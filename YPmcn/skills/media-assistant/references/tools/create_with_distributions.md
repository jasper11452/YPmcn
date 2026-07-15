# create_with_distributions

## 何时调用

供需、目标 MCN、消息和字段均获用户确认后调用；这是外部项目与分发写入。

## 输入

必填 `projectName`、`deadline`、`columns`、`supplierIds`、`prefillRows`、`prefillRowsBySupplier`；可选 `description`、`usageScope`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

保存实际返回；只有能证明 `project_id` 和 `mcn_id` 时才进入 sync。

## 错误与停止条件

不得发送旧 `mcn_recommendation_id`、`remindAt`、`sendWechatNotification` 或 `preview_only`。结果未知时不得重复创建。
