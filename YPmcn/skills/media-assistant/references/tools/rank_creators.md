# rank_creators

## 何时调用

结构化 brief、候选池、MCN/野生比例、MCN名单、表单字段和企微询价状态都满足当前流程要求，且用户确认进入精排后调用。

## 输入

必填 `demand_id`、`demand_version`、`ranking_strategy`。其他候选、权重、反馈偏好等字段只按运行时 schema 和用户确认传入。

## 输出成功证据

`run_id`、推荐项、排序快照、风险提示和可提报候选。

## 调用后必须停在哪里

展示可提报名单摘要和风险项；如存在 `need_confirm`，停在风险账号确认。确认后才进入 `create_submission_batch`。

## 禁止

不得在企微询价未完成或用户未确认精排时调用。不得把无有效 offer、未回填、未通过硬筛或缺风险说明的账号放入推荐结论。
