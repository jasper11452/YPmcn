# validate_requirement

## 何时调用

新 Brief 或同一需求的补充版本完成解析后调用。必填参数是当前 Tool schema 声明的 `payload`。本 Tool 每次成功调用都会写 `customer_demands`，没有 dry-run、schema 查询或探测模式；禁止用占位数据测试。

## 输入

必填 `payload`。先读取 `../requirement-intake.md` 并完成全部原子条件扫描；`payload` 只能使用真实 `customer_demands` 字段和控制字段 `status`。

再判断：

- `missing_required`：缺 `platform`、正整数 `quantityTotal`、合法 `submissionDeadlineAt`、可生成的审计 `rawMessagesJson`，或缺至少一个已确认档位的单达人官方报价范围；
- `semantic_ambiguity`：必填不缺，但字段、内容档位、日期、单位或有限范围端点不能唯一确定；
- `ready`：缺失和歧义都为空，所有原子条件已 mapped/preserved 且类型有效。

前两种状态用一次自包含 `AskUserQuestion` 问全后停止，不调用本 Tool；不得传 `status: "draft"` 制造半成品记录。只有 `ready` 才展示并调用完全相同的 `{"payload": {..., "status": "ready"}}`。

## 真实 payload 字段

除 `status` 外，Agent 传入的每个业务字段都必须出现在 `../reference_schema.csv`。常用字段：

| 业务含义 | 字段 | 规则 |
|---|---|---|
| 平台 | `platform` | `xiaohongshu` 或 `douyin` |
| 数量 | `quantityTotal` | 正整数 |
| 提报截止 | `submissionDeadlineAt` | `YYYY-MM-DD HH:mm:ss`；原文放审计 atom |
| 单达人官方报价 | `kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3` | 人民币元范围字符串 `"[min,max]"`；至少一项且上界大于 0 |
| 项目/品牌/产品 | `projectName/brandName/product` | 原文明确时写字符串 |
| 内容 | `contentTag/description` | 只有含义精确时写；其余逐字 preserved |
| 标签 | `contentFeatureLabel/contentThemeLabel/kolPersonaLabel/talentTypeLabel/pgyBloggerTypeLabel/xtTalentTypeLabel` | 只写真正 JSON，不猜标签体系 |
| 账号/地域/性别 | `kwUserUrl/kwIpDependency/kwGender` | 按原文写 |
| 返点 | `rebate` | 客户提供时保留原始表达；业务可选 |
| 档期 | `projectStartStart/projectStartEnd` | `YYYY-MM-DD HH:mm:ss` |
| 需求审计 | `rawMessagesJson` | 非空 `ypmcn-brief-v1` 对象 |

`id`、`demandVersion`、`createdAt`、`updatedAt` 由 Provider 管理。首次创建不传这些字段；补充同一需求只传上一成功响应的 `demandId`，版本由 Provider 原子分配。

当前表没有 `businessIndustry`、`budgetMinCents`、`budgetMaxCents`、`budgetRaw`、`rebateMinRate`、`rebateMaxRate`、`rebateRaw`、`submissionDeadlineRaw`。项目总预算和其他无专用字段的内容只进入 `rawMessagesJson`，不得杜撰字段。

## 范围归一化

CSV 注释为范围的 `varchar` 字段必须传无空格字符串 `"[min,max]"`：

- 单值 `x` → `"[x,x]"`；
- 上限 `x` → `"[0,x]"`；
- 闭区间 `a-b` → `"[a,b]"`；
- 50% → `0.5`。

两端必须是有限非负数且 `min <= max`；比例范围必须落在 0–1。只给下限且没有明确有限上限时必须询问。不得传数组、自然语言比较符、带空格变体或目标 `*Min/*Max` 字段。`validate_requirement` 只保存 `customer_demands` source 字段的范围字符串；搜索/手扒时，后端才依据已确认的 `field_match_mapping` 拆成目标 Min/Max，Agent 不参与拆分。

小红书图文/视频单达人报价分别使用 L1/L2；抖音 1–20 秒、21–60 秒、60 秒以上分别使用 L1/L2/L3。价格金额明确但档位不明时必须问，不能落到项目总预算或任意档位。

## rawMessagesJson

必须是对象：`schemaVersion="ypmcn-brief-v1"`、完整 `originalBrief`、非空 `atoms`、计数一致的 `coverageCheck`。每个 atom 的 `sourceText` 是原文子串；mapped 指向 payload 中真实字段；preserved 的 `preservedText` 与原文完全一致；`unresolvedCount=0`。任何遗漏、占位符或二次序列化都阻断。

## 输出成功证据

- retain actual returned payload as downstream evidence
- 实际返回 `success=true`、需求主键、`status=ready`、`workflow_state` 和 `allowed_actions`。

## 调用后必须停在哪里

只有实际返回 `success=true`、需求主键、`status=ready` 和允许的下一动作才进入搜索。status 非 ready、缺 ID 或返回错误时停止。写调用超时或断连属于结果未知，先用 `get_workflow_state` 对账，禁止重放相同写入。

## 错误与停止条件

任何必填缺失、语义歧义、虚构字段、Provider 管理字段、错误类型、非规范范围、审计覆盖不全、占位符、schema 冲突或未知写结果都必须停止。不得用 `draft`、空串、null、假值或重复调用绕过。
