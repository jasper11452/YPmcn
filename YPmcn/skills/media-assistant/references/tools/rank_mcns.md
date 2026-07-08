# rank_mcns

## 何时调用

真实候选池已形成，且需要判断 MCN 供给、机构排序、询价范围时调用。多平台需求按平台分别调用。

## 输入

必填 `demand_id`、`demand_version`、`platform`。中风险继续只在用户明确确认后传 `medium_risk_confirmed: true`。

`minimum_mcn_count` 默认 5 只是询价覆盖目标，不覆盖硬筛事实。硬筛后合格 MCN 少于 5 家时，`minimum_mcn_count=5` 自动失效，按实际合格 MCN 输出并预警媒介是否启动 `manual_source_creators` 手扒。

## 输出成功证据

MCN 排序列表、库存判断、`inquiry_advice`、建议 MCN/野生比例、累计供给倍数和是否可发送询价。

## 调用后必须停在哪里

先停在 MCN/野生比例确认；再停在 MCN 机构名单确认；然后停在表单字段确认。三者确认前不得发送企微询价。

## 禁止

不得把 MCN 排序结果当作已发送。不得跳过比例确认、机构剔除/补充、表单字段确认。不得为了凑满 5 家放宽硬筛条件或扩充不合格 MCN。不得将中风险默认视为已确认。
