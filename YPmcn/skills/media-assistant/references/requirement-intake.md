# 需求入口

## 输入模式

`validate_requirement` 接受至少一种模式，也允许两者共存：

- raw：`raw_messages` 或 `raw_messages_json`；
- structured：mvp-v2 profile 中声明的任一结构字段。

运行时 schema 是语法权威。Agent 不要求用户提供 `trace_id` 或幂等键。第一次 validation 前只处理会造成错误业务写入的硬冲突：不支持或无法映射的平台、缺少年份或已经过去的档期、多平台数量口径、预算是单人还是总额，以及无法解析的语病；其余信息不增加无关确认。

## 解析原则

- 保留原文，不把推测写成客户事实。
- 平台仅用 `xhs`、`dy`。
- 金额写分，返点写 0–1 小数，时间写带时区 ISO 8601。
- 单值预算可按已确认口径映射为闭区间；不确定就停在 `requirement_draft`。
- 扩展筛选字段必须来自 `creator_candidate_pool_schema.csv`。

## 成功与停止

只有 `success === true`、`data.id` 存在、`data.status === ready` 时，才把 ID 记为 `requirement_id` 并进入搜索。status 非 ready 时只向媒介展示缺项，不伪造补齐。
