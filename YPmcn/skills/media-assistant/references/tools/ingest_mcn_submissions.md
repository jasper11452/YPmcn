# ingest_mcn_submissions

## 何时调用

已有当前 inquiry 和真实回收条目时调用。

## 输入

必填 `inquiry_id`、`items`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

保存实际 ingest 结果，再执行最终 sync；此时不能直接精排。

## 能力边界

只摄取已有真实回收条目，并要求本地已存在对应 `mcn_inquiries`。写入受 MCP 调用 Ledger 保护；相同成功请求返回已有摘要，in-progress/unknown 必须先对账。来源、缺失值和风险必须原样保留。
回收条目涉及达人或供应商身份时，以当前 MCP 接受/返回的 `kwUid`、`supplier_id` 为准；不得自行改写为 Spec 目标模型的 `creator_id`、`supplier_binding_id`。

## 错误与停止条件

不得发送旧 `mcn_recommendation_id`、`requirement_id`、`trigger` 形态。缺 inquiry 证据或 items 时停止。
