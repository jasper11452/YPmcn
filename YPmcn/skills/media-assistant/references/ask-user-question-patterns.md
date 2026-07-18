# AskUserQuestion 交互

## 通用规则

- 只在歧义会改变结果、缺少关键字段或需要不可逆确认时弹框。
- 问题文字必须自包含：当前事实、待决定事项、差异和选项后果都写入弹框。
- 提供 2–3 个业务选项，不添加“拒绝/取消”；Reject 按钮已经承担停止动作。
- 最后一项必须允许用户自行输入。当前宿主若没有真实输入框，不得放一个无法输入的“其他”；让用户 Reject 后在聊天补充，并标记宿主能力未达标。
- Reject、超时或无结构化答案均视为未授权，停止当前动作。

## 需求澄清

header 固定为“需求确认”，question 固定按“已确认：…；需确认：…；影响：…”组织，一次最多合并 3 个问题。选项使用完整业务含义，例如“单达人预算上限 3 万元，使用小红书 L2 档”而不是“选项 A”。自由输入用于用户提供新的数值或规则。

## 列表选择

Ask 当前最多 4 个选项。候选过多时提供 2–3 个有明确范围的推荐组合，自由输入允许填写机构编号；不要截断事实后让用户盲选。

## 搜索后供给方案确认

`search_creators` 成功后、调用 `rank_mcns` 或其他后续业务 Tool 前必须弹框。问题中展示以下字段与计算口径：

- `demand_count`：已校验的 `quantityTotal`；
- `database_candidate_count`：本次搜索按 `(platform, kwUid)` 去重后的硬筛通过达人账号数；
- `supply_demand_ratio`：`database_candidate_count / demand_count`；
- `target_submission_count`：本轮目标提报账号数；
- `estimated_valid_return_count`、`estimated_gap_count`；
- `recommended_mcn_count`：建议询价机构家数；
- `mcn_covered_creator_count`：这些机构预计覆盖的去重达人账号数；
- `recommended_manual_creator_count`：`max(ceil(demand_count * 20%), estimated_gap_count)`；
- `mcn_manual_creator_ratio`：`mcn_covered_creator_count : recommended_manual_creator_count`。

机构家数和达人账号数不是同一量纲，禁止直接相除。除明确公式外的输入必须来自 `search_creators` 返回的 `supply_plan`；缺任一项返回 `integration_required`，不猜测。保留 Hook 返回的 `[YP_SUPPLY_PLAN_CONFIRMATION:<confirmation_id>]`，选项固定为“确认供给方案”“调整方案”。只有精确选择“确认供给方案”才允许用相同 `id + platform` 调用 `rank_mcns`。

## 外发确认

先调用 `get_workflow_state`；返回必须对应同一项目，且 `allowed_actions` 明确包含 `create_with_distributions`。缺少、过期、项目不一致或未授权时，按 Hook 的 `WORKFLOW_STATE_REFRESH_REQUIRED` / `BLOCKED_WORKFLOW_ACTION` 停止。状态通过后首次 `create_with_distributions` 会被 Hook 阻断并返回 `confirmation_id`，随后调用 Ask：

- 问题中原样保留 `[YP_CONFIRMATION:<confirmation_id>]`。
- 按 Hook 返回值逐项展示 `project_name`、`supplier_count`、`deadline`、`column_names`、`message_template_id`、`message_template_sha256`，并展示需求摘要、MCN 名单、固定消息预览以及“不可逆”；不得自己重算或改写这些绑定值。
- 业务选项固定为“确认发送”“需要修改”。
- 只有实际结果精确包含“确认发送”才授权。
- 用完全相同参数重试；任一参数变化都需要新确认。

写结果未知时确认凭证进入 unknown，必须先调用 `get_workflow_state`，不得再次弹框后重发。
