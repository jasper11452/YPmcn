# create_submission_batch

## 何时调用

精排实际返回当前 run 后调用。

## 输入

必填 `run_id`；可选 `target_submission_count`、`recommendation_item_ids`、`exclude_submitted`、`allow_need_confirm_with_risk`、`risk_confirmation`、`created_by`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际批次结果。需要交付时，读取 `../../assets/ypmcn_submission_template.csv`，要求宿主 `export_csv` 的第一行与模板逐字节一致；不得让 Agent 自选列、改列名或导出内部 ID/权重。随后等待客户反馈。

## 能力边界

该工具创建提报批次，不等于客户已查看或对客发送。`export_csv` 只负责固定格式渲染，不推进 workflow phase，也不能补造批次响应中不存在的数据。

## 错误与停止条件

run 不匹配或写结果未知时先查详情，不新建第二批。
