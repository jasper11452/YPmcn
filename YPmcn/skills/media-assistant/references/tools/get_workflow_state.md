# get_workflow_state

## 何时调用

需要只读核对需求版本、trace 对应流程事实，或写结果未知需要先对账时调用。

## 输入

二选一：传 `demand_id` 与 `demand_version`；或只传 `trace_id`。不得混用无关需求版本和 trace。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

查询不推进主链。只展示实际状态，并据此判断是否安全恢复、重试或返回 `integration_required`。不可逆外发前的成功结果会被 Hook 保存为 10 分钟安全摘要；项目名不一致、摘要过期或未授权都会阻断外发。

## 能力边界

它不需要新建一张“大状态表”。服务端只聚合现有需求、候选、MCN 推荐、ledger、sync/inquiry、回收、推荐 run 与批次事实，再派生 phase、关键 project/distribution/inquiry ID 和 `allowed_actions`；`started/unknown` 写入必须清空后续写动作并要求对账。它不证明缺失的业务动作成功，也不能用本地 Hook phase、健康检查或推测状态替代返回结果。待部署源码已提供该聚合与 `returned_not_ingested` 断点，但当前远程返回仍是唯一运行时依据。

派生必须从最晚的已提交事实向前判断，并且只返回一个 phase：已提交 batch/submissions → `submission_batch_ready`；成功 recommendation run/items → `recommendation_ready`；全部有效 inquiry 已终态且回填已入库 → `candidate_pool_enriched`；已有真实 distribution/inquiry 但回收未完成 → `waiting_mcn_return`；已有 MCN 推荐项 → `mcn_planning`；已有候选池 → `candidate_pool_ready`；需求 `ready` → `requirement_ready`；否则为 `requirement_draft`。需求关闭优先返回 `closed`；任何关联多义、事实冲突或 ledger `started/unknown` 优先返回 `blocked`，并清空不可逆写动作。

返回至少包含本次解析到的需求身份、phase、关键业务 ID、每项事实来源、唯一 `allowed_actions` 和一个阻塞原因。每个 inquiry attempt 还必须返回自身匹配的 `project_id`、`distribution_id`、`sync_id` 与 `recovery_id`；不得把同一机构不同项目的恢复标识串用。新 session 只使用该返回继续；本地 `confirmation_guard.json` 只负责十分钟确认门禁，绝不能成为跨 session 的业务状态源。

## 错误与停止条件

缺少完整的 `demand_id` + `demand_version` 且也没有 `trace_id` 时停止。查询不到、版本冲突或结果含糊时不得补造状态。
