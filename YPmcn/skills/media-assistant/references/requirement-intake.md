# 需求入口

用户输入 Brief → Agent 对照 `creator_candidate_pool_schema.csv` 解析字段 → 构造 JSON 调 `validate_requirement`

## 解析输出格式

Agent 解析完需求后，**必须**以三列表格输出，不得以其他格式呈现：

| 字段名 | 内容 | 置信度 |
|---|---|---|
| `platform` | 小红书 | 确定 |
| `category_requirements` | 生活方式类、美食探店类 | 确定 |
| `budget_raw` | 图文5k-3w/视频1w-5w | 确定 |
| `quantity_total` | — | 缺失 |

**置信度取值**：`确定`（原文明确）、`推断`（从上下文推理，需标注推理依据）、`缺失`（原文未提及）。禁止使用「可能」「大概」等模糊词。

**强制规则**：
- **禁止 Agent 无中生有**：原文未提及的字段一律标 `缺失`，不得编造、猜测、或用「行业惯例」填充
- **禁止 Agent 私自填充**：`缺失` 字段的 `内容` 列写 `—`，不得填入任何推断值。后端自行处理缺失字段
- **禁止推断值混入调用参数**：`validate_requirement` 只传原文中可确定提取的字段。即使必填项缺失导致 `draft`，也不允许 Agent 自行补值
- 弹窗只允许展示缺失项/模糊项，Agent 不得替用户做决定

## 表与字段口径

需求主表固定为 `customer_demands`；`validate_requirement` 写入 `customer_demands`，字段以 `references/creator_candidate_pool_schema.csv` 的 `字段` 列为准。达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`；字段从需求主表继承，按平台可用列匹配，候选中间层仍是 `creator_candidate_pool`。

## 字段精度

| 字段 | 规则 |
|---|---|
| `platform` | `"xhs"`（小红书）、`"dy"`（抖音）。**禁止** `xiaohongshu` / `小红书` |
| `budget_min_cents` | 单位 **分**。预算/单价必须区间化；原文只给上限时下限按业务可接受下界归一 |
| `budget_max_cents` | 单位 **分**。3万 → `3000000` |
| `rebate_min_rate` / `rebate_max_rate` | 单位 **小数**。20% → `0.2`，**禁止**传 `20`。`rebate_min_rate` 必填，`rebate_max_rate` 可选（未填时视为无上限） |
| 无独立字段的筛选条件 | 放入 `requirements_json` |

继续前必填项：`platform`、`submission_deadline_at`、`raw_messages_json`、`budget_min_cents`、`budget_max_cents`、`budget_raw`、`rebate_min_rate`、`rebate_raw`、`quantity_total`。缺任一项不可继续。返点仅下限必填，`rebate_max_rate` 可选（未填时视为无上限）。

字段名与 CSV `字段` 列完全一致（蛇形命名）。额外需求必须参考 `creator_candidate_pool_schema.csv` 匹配到需求表字段或达人筛选字段，直接复核落库，不需弹窗确认。

## 调用后

- `status=draft`：展示最多 3 个缺失项/模糊点用弹窗问用户
- `status=ready`：直接展示摘要（平台、数量、deadline、预算/返点区间等），进入 `search_creators`
- 用户修改 Brief：重新解析 → 调 `validate_requirement`
- `VERSION_CONFLICT` → 停，让用户选"重新校验/放弃/强制覆盖"

**参考**：CSV 字段来源 `references/creator_candidate_pool_schema.csv`
