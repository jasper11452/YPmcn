# audit_manual_adjustment

## 何时调用

`rank_creators` 已返回当前会话的实际 `run_id`、本地 phase 为 `recommendation_ready`，且媒介已明确人工调整及原因时调用。该工具是业务写，不是只读查询。

## 输入

必填当前会话匹配的 `run_id`、至少一项带非空 `reason` 的 `adjustments`、非空 `operator_id`。调用还必须具备当前 `sessionKey` 和 `toolCallId`；不得借用其他会话或推荐 run。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际记录结果并保持 `recommendation_ready`；需要时只读查询 run 详情，确认后才能创建提交批次。

## 能力边界

当前实现直接修改推荐 item 的 JSON、原因或状态，没有写入不可变审计流水。因此不能可靠回答谁在何时把什么从什么改成什么，也不能承担合规审计。

## 错误与停止条件

缺操作者、调整内容或原因时不得写入；未知结果不盲目重试。
