# search_creators

## 何时调用

结构化 brief 已由媒介确认，且 `validate_requirement` 成功返回的 `data.id` 可用时调用。

## 输入

必填 `id`（来自 `validate_requirement.data.id`）。其余参数按运行时 schema 传入。

## 输出成功证据

候选池或供给评估结果，必须能定位 `data.id`（`creator_candidate_pool`/搜索结果 ID），并包含候选数量、供给风险、实际放宽字段和是否写入候选池。

MCP 根据 `customer_demands` 主键读取所有非空且已确认字段，与 `xhs_creator_accounts` / `dy_creator_accounts` 同字段匹配筛选；字段从需求主表继承，Agent 不重复传筛选条件。

## 调用后必须停在哪里

如果供给不足或字段缺失，停在补资源库/达人拓展/放宽确认。供给可继续时，用 `search_creators.data.id` 进入 `rank_mcns`；比例确认在 `rank_mcns` 成功后进行。

## 禁止

不得传 Agent 自行构造的结构化需求、数量或筛选字段。不得静默放宽硬筛条件。不得用虚拟达人或虚拟报价补足候选。
