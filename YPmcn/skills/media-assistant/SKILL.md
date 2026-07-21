---
name: media-assistant
description: "Use for YPmcn requirement parsing, phase-independent manual creator sourcing, optional field selection, creator filtering/deduplication, and spreadsheet batch export."
---

# YPmcn 媒介助手

只用已安装的 YPmcn MCP 完成需求解析、手扒和可选导出；禁止 shell、curl、数据库直连、虚构结果或替代写接口。

## 执行规则

- 开始前取得完整需求和手扒数量 `size`；需要导出时再确认 `platform`、字段和批次号 `number`。`size`、`number` 都使用正整数十进制字符串，缺值时一次性询问，不猜测。
- Endpoint schema 优先，并与根 `spec/manifest.json` 指向的正式契约核对；必需 Tool 缺失、契约冲突或证据不足即 `integration_required`，不得回退旧参数。
- 每次调用前先读 `references/tools/<tool>.json`，只传其中字段；只有实际 MCP 成功响应才是后续证据。
- 手扒不受当前流程阶段限制。每次调用前都按 `requirement-intake.md` 重新解析需求并成功调用 `validate_requirement`；只把该响应新生成的 `requirement_id` 用于紧邻的一次手扒，禁止复用旧 ID。
- 除上述当次新 ID 外，不检查该需求是否历史检索过或其他流程是否完成。其余 ID 仍逐项核对 ID 血缘，只复制本轮实际成功响应返回的 ID；不得猜测、串用或用虚构 ID 探测。
- 任一步失败都停止后续业务 Tool。写结果未知时先对账，禁止盲重试；用户要求失败即停时绝不重试。
- Hook 只硬校验手扒的一次性新需求 ID 和企微外发确认，不把 phase、历史检索或其他流程完成度当作手扒门槛；本地状态只按实际成功结果推进，preview 不限制 Skill 读取或其他 Tool。

## 主链

`select_inquiry_form_fields → validate_requirement → manual_source_creators → rank_creators → create_submission_batch`

1. 仅需要导出时先执行 `select_inquiry_form_fields({platform})`，等待网页选择并按原序保留非空 `key/name` 字段；只手扒时跳过。
2. 紧接手扒前重新解析完整需求并调用 `validate_requirement`；新建参数不得携带旧 `id/demandVersion`，也不要自动插入 `search_creators`。
3. 仅用第 2 步实际成功响应新生成的 ID 调用 `manual_source_creators({requirement_id,size})`；该 ID 用后即失效，禁止发送 `target_count`。
4. 需要导出时，只取手扒成功响应的非空 `inquiry_ids`，连同相同 `requirement_id` 和本轮 `columns` 调用 `rank_creators` 筛选去重。
5. `rank_creators` 成功后同轮调用 `create_submission_batch({requirement_id,size,number})` 导出表格；禁止发送 `run_id` 或旧批次选项。

`requirement_id`、`size` 在手扒与导出步骤必须完全一致；`inquiry_ids` 和 `columns` 必须来自本轮前序成功结果。`validate_requirement` 与手扒之间不得插入其他业务 Tool；导出链中不要插入搜索、赛马、企微分发、详情查询、宿主 CSV 导出或额外确认。

## 按需读取

- 状态、确认、恢复：[`execution-gates.md`](references/execution-gates.md)
- 字段转换：[`form-field-mapping.md`](references/form-field-mapping.md)
- 回复格式：[`frontend-response.md`](references/frontend-response.md)
- 每次手扒前的 Brief 解析：[`requirement-intake.md`](references/requirement-intake.md)
- 每个 Tool 的调用格式：[`references/tools/`](references/tools/)

每次只读当前场景所需文件。
