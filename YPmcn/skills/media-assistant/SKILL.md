---
name: media-assistant
description: "Use for YPmcn web field selection, manual creator sourcing, creator filtering/deduplication, and spreadsheet batch export."
---

# YPmcn 媒介助手

只用已安装的 YPmcn MCP 完成手扒导出；禁止 shell、curl、数据库直连、虚构结果或替代写接口。

## 执行规则

- 开始前取得并确认 `platform`、`requirement_id`、手扒数量 `size` 和批次号 `number`；`size`、`number` 都使用正整数十进制字符串。缺值时一次性询问，不猜测。
- Endpoint schema 优先，并与根 `spec/manifest.json` 指向的正式契约核对；必需 Tool 缺失、契约冲突或证据不足即 `integration_required`，不得回退旧参数。
- 每次调用前先读 `references/tools/<tool>.json`，只传其中字段；只有实际 MCP 成功响应才是后续证据。
- 逐项核对 ID 血缘，只复制本轮实际成功响应返回的 ID；不得猜测、串用或用虚构 ID 探测。
- 任一步失败都停止后续业务 Tool。写结果未知时先对账，禁止盲重试；用户要求失败即停时绝不重试。
- Hook 不校验普通 Tool 参数、需求完整性、ID 血缘或工作流顺序；本地状态只按实际成功结果推进，preview 不限制 Skill 读取或其他 Tool。

## 主链

`select_inquiry_form_fields → manual_source_creators → rank_creators → create_submission_batch`

1. 首个业务调用使用已确认平台执行 `select_inquiry_form_fields({platform})`，弹出网页并等待字段选择完成。按原序保留返回的非空 `key/name` 字段。
2. 字段选择成功后立即调用 `manual_source_creators({requirement_id,size})`；禁止发送旧参数 `target_count`。
3. 只取该手扒成功响应实际返回的非空 `inquiry_ids`，连同相同 `requirement_id` 和本轮 `columns` 调用 `rank_creators` 筛选去重。
4. `rank_creators` 成功后同轮调用 `create_submission_batch({requirement_id,size,number})` 导出表格；禁止发送 `run_id` 或旧批次选项。

`requirement_id`、`size` 在第 2、4 步必须完全一致；`inquiry_ids` 和 `columns` 必须来自本轮前序成功结果。不要在步骤间插入搜索、赛马、企微分发、详情查询、宿主 CSV 导出或额外确认。

## 按需读取

- 状态、确认、恢复：[`execution-gates.md`](references/execution-gates.md)
- 字段转换：[`form-field-mapping.md`](references/form-field-mapping.md)
- 回复格式：[`frontend-response.md`](references/frontend-response.md)
- 非本主链的 Brief 解析：[`requirement-intake.md`](references/requirement-intake.md)
- 每个 Tool 的调用格式：[`references/tools/`](references/tools/)

每次只读当前场景所需文件。
