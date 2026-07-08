# 需求入口

用户输入 Brief → Agent 对照 `creator_candidate_pool_schema.csv` 解析字段 → 构造 JSON 调 `validate_requirement`

## 字段精度

| 字段 | 规则 |
|---|---|
| `platform` | `"xhs"`（小红书）、`"dy"`（抖音）。**禁止** `xiaohongshu` / `小红书` |
| `budget_min_cents` | 单位 **分**。原文没下限 → `null`，不编造 |
| `budget_max_cents` | 单位 **分**。3万 → `3000000` |
| `rebate_min_rate` / `rebate_max_rate` | 单位 **小数**。20% → `0.2`，**禁止**传 `20` |
| 原文无返点 | `null`，不为了 ready 编造 |
| 无独立字段的筛选条件 | 放入 `requirements_json` |

字段名与 CSV "合并结果"列完全一致（蛇形命名）。范围值用 `{"min": x, "max": y}`。枚举用数组。不得编造原文未提供的信息。

## 调用后

- `status=draft`：展示最多 3 个缺失项/模糊点用弹窗问用户
- `status=ready`：展示摘要（平台、数量、deadline、预算等），弹窗确认后才 `search_creators`
- 用户修改 Brief：重新解析 → 调 `validate_requirement`
- `VERSION_CONFLICT` → 停，让用户选"重新校验/放弃/强制覆盖"

**参考**：CSV 字段来源 `references/creator_candidate_pool_schema.csv`
