# 人工确认模式

问题应短、互斥、可执行，选项不超过 3 个。一次只确认会改变下一动作的决策。

## 发送前

1. 供需判断：接受 / 调整筛选 / 停止。
2. 目标 MCN：接受名单 / 调整名单 / 停止。
3. 外发消息：确认文案 / 修改 / 停止。
4. 字段选择：由 `select_inquiry_form_fields` 完成最后确认。

三项确认分别对应 `supplyConfirmed`、`mcnConfirmed`、`messageConfirmed`。确认完成后，由具备 `operator.write` scope 的客户端通过 `confirm_distribution_send` session action 写入当前 `mcn_recommendation_id` 的会话证据；不能从 `before_tool_call` 虚构字段，也不能用一次笼统“继续”替代所有证据。

## 回收

普通询问进度不代表回收确认。仅“继续回收”“现在回收”“提前回收”或等价结构化确认触发 manual 路径。scheduled 路径不向用户补问，必须由 cron 上下文触发。
