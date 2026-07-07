# search_creators

## 何时调用

结构化 brief 已由媒介确认，且 MCP 返回的 `demand_id`、`demand_version` 可用时调用。

## 输入

必填 `demand_id`、`demand_version`。可选 `authorized_relaxations`、`write_candidate_pool`、`limit` 只按运行时 schema 传入。

## 输出成功证据

候选池或供给评估结果，包括候选数量、供给风险、实际放宽字段和是否写入候选池。

## 调用后必须停在哪里

如果供给不足或字段缺失，停在补资源库/手扒/放宽确认。供给可继续时，先确认数据指标和筛选口径，再进入 `rank_mcns`。

## 禁止

不得传 Agent 自行构造的结构化需求、数量或筛选字段。不得静默放宽硬筛条件。不得用虚拟达人或虚拟报价补足候选。
