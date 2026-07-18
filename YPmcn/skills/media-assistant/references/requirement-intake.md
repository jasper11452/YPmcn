# 需求入口

## 权威与输入

`customer_demands` 当前 61 列是需求解析和落库的最高权威，随 Skill 打包的 `reference_schema.csv` 是其 2026-07-18 真实开发库快照。`field_match_mapping` 是后端把需求范围拆成达人筛选 Min/Max 的权威映射。Agent 只负责把客户原文稳定解析成 `customer_demands` 字段，不自行推导达人表字段，也不传历史字段。

`validate_requirement` 接受当前宿主 Tool schema 声明的 `payload`。除控制字段 `status` 外，每个业务字段必须存在于参考 CSV；若运行时 schema 与 CSV 冲突，停止并返回 `integration_required`，不得猜字段。

## 必填口径

新 Brief 的业务最小必填为：

- `platform`：仅 `xiaohongshu` 或 `douyin`；
- `quantityTotal`：正整数；
- `submissionDeadlineAt`：`YYYY-MM-DD HH:mm:ss`；
- `rawMessagesJson`：合法的 `ypmcn-brief-v1` 审计对象；
- `kolOfficialPriceL1/L2/L3` 至少一项合法且上界大于 0 的 `"[min,max]"`，并能确定内容档位。

`projectName`、`brandName`、`product`、项目档期、项目总预算、返点和其他约束为业务可选。`rebate` 物理列不允许 NULL，但客户未提供返点时 Agent 不得编造；空值落库策略属于 Provider，不得由 Agent用假值绕过。

## 范围字段硬格式

参考 CSV 注释为“范围”的 `varchar(255)` 字段统一传无空格字符串 `"[min,max]"`。两端必须是有限非负数，且 `min <= max`：

- 确定单值 5000 → `"[5000,5000]"`；
- 不超过 5000 → `"[0,5000]"`；
- 3000–5000 → `"[3000,5000]"`；
- 不超过 50% → `"[0,0.5]"`。

比例字段先把百分数换成 0–1 小数；`photoInteract`、`femaleRate`、`age1Rate`—`age6Rate` 的两端都必须在 0–1。只有下限而没有明确有限上限时不得发明上限，列为 `semantic_ambiguity` 并一次询问。不得传 JSON 数组、自然语言、`>=5000`、`3000-5000` 或带空格的变体；数据库列是 varchar，值必须是上述规范字符串。

后端读取需求后，按 `(platform, source_field_name, match_status='已匹配')` 查询 `field_match_mapping`，把 `[min,max]` 分别送入该字段已确认的目标参数。Agent 不拆 `*Min/*Max`，不改映射表，也不把目标参数名写回 `customer_demands`。

## 高频映射

- 小红书/XHS/红书 → `platform="xiaohongshu"`；抖音/DY/Douyin → `platform="douyin"`。
- 人数 → `quantityTotal`。
- 项目、品牌、产品 → `projectName`、`brandName`、`product`。
- 内容标签 → `contentTag`；明确的内容要求可写 `description`；只有原文给出可验证标签结构时才写 JSON 标签字段。
- 达人主页 → `kwUserUrl`；性别 → `kwGender`；IP 属地 → `kwIpDependency`。
- 达人官方价、刊例价、单人预算或与发文类型绑定的价格 → 按明确档位写 `kolOfficialPriceL1/L2/L3` 的范围字符串。小红书图文/视频对应 L1/L2；抖音 1–20 秒、21–60 秒、60 秒以上对应 L1/L2/L3。
- 返点原文 → `rebate`；不拆分为不存在的 `rebateMinRate/rebateMaxRate`。
- 项目档期 → `projectStartStart/projectStartEnd`；提报截止 → `submissionDeadlineAt`。原始时间表述保留在 `rawMessagesJson` atom，不创建 `submissionDeadlineRaw`。
- 项目总预算当前没有专用列，只逐字保留在 `rawMessagesJson`，不创建 `budget*`。

字段含义不能精确对应时完整保留原文，不把相似字段当同义字段。参考账号、审美、负向要求、排竞、授权和调性等没有可靠专用列的条件都进入 `rawMessagesJson`。

## 三遍解析与审计

第一遍逐句拆成不可再分的原子条件，至少检查平台、数量、截止、单达人预算及档位、项目/品牌/产品、内容、画像、地域、账号、返点、档期、效果指标、负向要求和总预算。

第二遍逐条处置：能唯一映射且值合法就写真实字段；没有专用字段就逐字保留；字段、档位或范围端点不能唯一确定就进入歧义清单。`rawMessagesJson` 固定包含：

- `schemaVersion="ypmcn-brief-v1"`；
- 完整非空 `originalBrief`；
- 非空 `atoms`；每项含原文子串 `sourceText`、`mapped/preserved`、0–1 `confidence`、布尔 `inferred`；
- mapped atom 的 `targetField` 必须实际存在于 payload；preserved atom 的 `preservedText` 必须与 `sourceText` 完全一致；
- `coverageCheck.atomCount/mappedCount/preservedCount` 与 atoms 一致，`unresolvedCount=0`。

第三遍从 payload 和 atoms 反向逐条核对原 Brief。任何遗漏、错误字段、错误类型、未规范范围或占位符都阻断。

## 三态门禁与询问

先完整生成缺失清单和歧义清单，再选状态：有必填缺失为 `missing_required`；无缺失但有真实歧义为 `semantic_ambiguity`；两者都无才是 `ready`。可确定的闭区间不是歧义，必须直接规范。

阻断时只展示已确定字段，用一次自包含 `AskUserQuestion` 合并最多三个关键问题：header 固定“需求确认”，question 按“已确认：…；需确认：…；影响：…”组织。单达人预算问题必须同时确认金额范围与内容档位。阻断状态禁止调用 Tool、禁止写 `status=ready`，也禁止使用 `TBD`、空串或假值。

标准 Brief 使用宿主注入的确定性解析/预览规则，不再读取 Skill、reference 或 Tool card，也不调用 `read`、resources、prompts、schema probe 或业务 Tool。未决门禁在澄清前必须保持零 Tool 调用；只有宿主明确提供的原生 `AskUserQuestion` 可以作为例外，不能用 MCP `prompts_get` 或其他 prompt wrapper 模拟。原生 Ask 不存在时，在聊天中给出同一问题并停止。

预览是单一 JSON envelope，键顺序固定如下；不要在 JSON 前后另写一份独立计数的自然语言预览：

```json
{
  "requirementPreview": {
    "gate": "missing_required|semantic_ambiguity|ready",
    "resolvedFields": {},
    "atoms": [],
    "missingRequired": [],
    "semanticAmbiguities": [],
    "summary": {"atomCount": 0, "mappedCount": 0, "preservedCount": 0, "unresolvedCount": 0},
    "nextAction": "ask_user|validate_requirement"
  },
  "clarification": null,
  "toolArguments": null
}
```

三个块始终存在。每个 atom 必须来自同一内存列表且只含一个 `resolution`：mapped 行使用单数 `targetField` 与类型正确的 `value`；preserved 行使用逐字 `preservedText`；未决行使用 `resolution="missing_required"` 或 `resolution="semantic_ambiguity"` 与 `reason`，不得伪造正式 audit 的 disposition。禁止 `targetFields`、`dispositions`、`targetField="fieldA+fieldB"` 或任何组合处置。`summary` 从该数组机械计数；未决时 `clarification` 填完整问题结构、`toolArguments=null`。ready 时 `clarification=null`，`toolArguments` 是随后调用逐字复用的 `{"payload": {..., "status": "ready"}}`；所有 datetime 都是带秒的 `YYYY-MM-DD HH:mm:ss`，`quantityTotal` 等整数是 JSON integer，只有 CSV 声明的范围字段是无空格 `"[min,max]"` 字符串。

`ready` 时展示与实际调用完全一致的 `{"payload": {..., "status": "ready"}}`，再调用一次。新建省略 `demandVersion`，也不传 `id`、`createdAt`、`updatedAt`；同一需求补充时只沿用 Provider 返回的 `demandId`，版本由 Provider 原子分配。

只有实际返回 `success=true`、需求主键和 `status=ready` 才进入搜索。写结果未知时用 `get_workflow_state` 对账，不重放写入。

状态迁移固定为：`received → scanned → missing_required|semantic_ambiguity|ready`；用户回答未决项后回到 `scanned` 并从原 Brief 与答案重建全量 atom 列表。`ready → validation_pending` 才能调用 Tool；实际成功证据使其进入 MCP 权威的 `requirement_ready`，明确失败进入 `blocked`，结果未知进入 `reconciliation_required`。preview gate 不是 `workflow_state`，Hook confirmation 也不推进任何业务 phase。
