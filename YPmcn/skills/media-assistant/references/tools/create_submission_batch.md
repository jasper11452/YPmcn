# create_submission_batch

## 何时调用

精排实际返回当前 run 后调用。

## 输入

必填 `run_id`；可选 `target_submission_count`、`recommendation_item_ids`、`exclude_submitted`、`allow_need_confirm_with_risk`、`risk_confirmation`、`created_by`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际批次结果，等待客户反馈。

## 错误与停止条件

run 不匹配或写结果未知时先查详情，不新建第二批。
