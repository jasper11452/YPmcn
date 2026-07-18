# validate_requirement

## 何时调用

新 Brief 或补充版本通过三态门禁后调用。每次成功调用都会写 `customer_demands`；没有 dry-run、schema 探测或占位测试。

## 输入

必填 `payload`。先按 [`../requirement-intake.md`](../requirement-intake.md) 完成原子扫描；除 `status` 外只传运行时 schema 或 [`../reference_schema.json`](../reference_schema.json) 中的真实字段。

- `missing_required`：缺平台、正整数数量、带秒截止时间、合法审计，或至少一个已确认档位且上界大于 0 的 `kolOfficialPriceL1/L2/L3`。
- `semantic_ambiguity`：必填已有候选，但字段、价格档位、日期、单位或有限端点不能唯一确定。
- `ready`：缺失与歧义皆空，所有 atom 已 mapped/preserved 且类型有效。

前两态一次问全后停止；不得传 `status: "draft"`。只有 `ready` 才展示并调用相同的 `{"payload": {..., "status": "ready"}}`。

常用字段：`platform`、`quantityTotal`、`submissionDeadlineAt`、`rawMessagesJson`、`projectName/brandName/product`、`contentTag/description`、`rebate`、`projectStartStart/projectStartEnd`、`kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3`。系统字段 `id/demandVersion/createdAt/updatedAt` 由 Provider 管理；补充版本只传上一响应的 `demandId`。

范围字段必须是无空格 `"[min,max]"` 字符串：单值、上限、闭区间分别规范为 `[x,x]`、`[0,x]`、`[a,b]`，比例先除以 100。不得传数组、自然语言范围或 `*Min/*Max`。小红书图文/视频用 L1/L2；抖音 1–20 秒、21–60 秒、60 秒以上用 L1/L2/L3。

`rawMessagesJson` 必须是 `ypmcn-brief-v1` 对象，包含完整原文、非空 atoms 和一致且 `unresolvedCount=0` 的 coverage；mapped 目标真实存在，preserved 逐字。

## 输出成功证据

- retain actual returned payload as downstream evidence
- 实际 `success=true`、需求主键、`status=ready`、`workflow_state` 与 `allowed_actions`。

## 调用后必须停在哪里

仅在上述证据完整且动作授权时进入搜索。非 ready、缺 ID 或明确错误立即停止；写超时/断连先对账，禁止重放。

## 错误与停止条件

必填缺失、语义歧义、虚构或系统字段、错误类型、非规范范围、审计不全、占位符、schema 冲突或未知写结果都停止；不得用 `draft`、null、空串、假值或重试绕过。
