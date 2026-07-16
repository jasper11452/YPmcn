# 需求字段解析

## 权威字段

`reference_schema.csv` 是当前提供的 153 字段权威。`customer_demands`、`xhs_creator_accounts`、`dy_creator_accounts` 和候选搜索使用同名字段时必须保持语义一致；不擅自改列名或造同义列。

## 常用映射

| 用户表达 | 参数 |
|---|---|
| 小红书 / 抖音 | `platform=xhs` / `platform=dy` |
| 人数 | `quantity_total` 正整数 |
| 3 万元 | `3000000` 分 |
| 20% 返点 | `0.2` |
| 截止时间 | 带时区 `submission_deadline_at`，并保留原文 |
| 内容与类目 | `content_requirements`、`category_requirements` 或已声明字段 |

## 冲突处理

同一字段存在冲突时保留原始消息并请求一次最小确认。Agent 修正解析不代表客户需求变更；是否产生新版本由业务 MCP 决定。没有 schema 字段承载的信息放入已声明的 JSON 扩展，不塞入无关列。
