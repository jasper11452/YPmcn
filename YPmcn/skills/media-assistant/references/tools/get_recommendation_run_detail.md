# get_recommendation_run_detail

## 何时调用

需要恢复流程、核对某次推荐运行、查看提报批次或确认客户反馈状态时调用。

## 输入

必填 `run_id`。可选 `include_submissions`、`include_creator_detail`、`include_feedback` 按运行时 schema 传入。

## 输出成功证据

推荐运行快照、提报批次、反馈和可选达人详情。

## 调用后必须停在哪里

只读查询不自动推进。根据查到的阶段和缺口，展示下一步选项并等待用户确认。

## 禁止

不得把查询不到的状态补造成成功。不得用当前新需求覆盖历史 `run_id` 快照。
