# create_submission_batch

## 何时调用

`rank_creators` 已成功返回真实 `run_id`，且媒介确认本轮提报范围后调用。

## 输入

必填 `run_id`。可选 `target_submission_count`、`recommendation_item_ids`、`exclude_submitted`、`allow_need_confirm_with_risk`、`created_by` 按运行时 schema 传入。

## 输出成功证据

批次号、提报达人明细、实际提报数量和风险处理结果。

## 调用后必须停在哪里

展示批次是否创建、最终提报名单和仍需人工处理的风险项；等待客户反馈或媒介下一步指令。

## 禁止

不得复用错误 `run_id`。不得默认带风险账号提报。不得为了凑数重复提报同一账号或弱化风险规则。
