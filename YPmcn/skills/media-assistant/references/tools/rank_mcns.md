# rank_mcns

## 何时调用

候选池已写入，需要形成 MCN 建议与询价方案时调用。

## 输入

必填 `candidate_pool_id`，值来自 search_creators.data.id。

## 输出成功证据

- success === true
- data.id
- data.inquiry_advice

data.id 记录为 mcn_recommendation_id。

## 调用后必须停在哪里

进入 `mcn_planning`。展示供需关系、目标 MCN 与外发建议，等待三项人工确认，再选择询价字段。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。不得为凑数量放宽硬筛，不得跳过人工确认直接发送。
