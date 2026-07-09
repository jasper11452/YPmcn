# rank_mcns

## 何时调用

真实候选池已形成，且需要判断 MCN 供给、机构排序、询价范围时调用。多平台需求按平台分别调用。

## 输入

必填 `id`（来自 `search_creators.data.id` 的候选池/搜索结果 ID）。中风险继续只在用户明确确认后传 `medium_risk_confirmed: true`。

`minimum_mcn_count` 默认 5 只是询价覆盖目标，不覆盖硬筛事实。硬筛后合格 MCN 少于 5 家时，`minimum_mcn_count=5` 自动失效，按实际合格 MCN 输出并预警媒介是否启动 `manual_source_creators` 达人拓展。

## 输出成功证据

MCN 排序方案 `data.id`、MCN 排序列表、当前达人供需关系、建议达人拓展比例、`inquiry_advice`、建议询价 MCN 列表、累计供给倍数和是否可发送询价。

## 调用后必须停在哪里

先展示当前达人供需关系、建议达人拓展比例、MCN 建议表，停等用户输入修改或确认。确认后 Agent 拟写企微消息，停等用户修改或确认。消息确认后弹窗询问是否发送。确认前不得发送企微询价。

## 禁止

不得把 MCN 排序结果当作已发送。不得跳过供需关系展示、达人拓展比例提示、机构剔除/补充、表单字段确认和企微消息确认。不得为了凑满 5 家放宽硬筛条件或扩充不合格 MCN。不得将中风险默认视为已确认。

## 中风险处理流程

若 `rank_mcns` 返回结果中包含风险 MCN，需按以下流程处理：

1. 展示风险 MCN 及风险原因，通过 `askuserquestion`（`confirm-medium-risk` 模式）请媒介确认。
2. 媒介确认接受风险后，**重新调用** `rank_mcns`，传入 `medium_risk_confirmed: true`。
3. 以第二次调用返回的结果为准，继续后续 MCN 比例和名单确认。
