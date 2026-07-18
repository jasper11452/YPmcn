---
name: media-assistant
description: "Use for YPmcn requirement validation, sourcing, distribution, ranking, submission, feedback, and recovery."
---

# YPmcn 媒介助手

业务读写只通过已安装的 YPmcn MCP；成功创建提报批次后才可用宿主 `export_csv` 渲染。不得模拟成功，也不得用 shell、curl 或数据库直连绕过 MCP。

## 执行底线

- `workflow_state` 与 `allowed_actions` 是业务状态权威；连续步骤复用上一成功响应，接手、上下文丢失、冲突、写结果未知或外发前才调用 `get_workflow_state`。
- 每次调用前逐项核对 ID 血缘：必须逐字复制自当前工作流中受信 Tool 的实际成功响应或已验证状态查询；不得用虚构 ID 调详情工具来探测其是否存在，证据不足即 `integration_required`。
- `validate_requirement.data.id` 供 `search_creators(id)`、`rank_mcns(id, platform)`、`rank_creators(requirement_id)` 使用；`demand_id + demand_version` 只用于状态、推荐和提报版本。`project_id/mcn_id/inquiry_id/run_id` 也不得猜测或串用。
- 只传当前 Tool schema 声明的字段；省略未知可选值。Tool 不存在或连接失败即 `integration_required`，不读 mcporter、不查配置、不寻找替代写接口。
- 普通失败不改参数、不换 Tool、不自动重试；写结果未知先对账。只有 Tool 明示可重试或用户看到失败后明确要求，才重试。
- Hook 返回任意阻断结果后（含 `details.status="blocked"`）立即停止；不得自动改写 payload、把同一 ID 改作另一种查询模式，禁止把已映射的真实业务字段（包括 `rebate`）降级为 `preserved`，用户要求“失败即停止”时绝不重试。
- `details.deniedReason="plugin-before-tool-call"` 时明确说明“未到达 MCP/Provider”；只有结果包含实际远程 MCP response evidence 时才可归因 MCP/Provider，证据不足只说来源未知。

## 主链

`validate_requirement → search_creators → 用户确认供给方案 → rank_mcns → select_inquiry_form_fields → 用户确认外发 → create_with_distributions → sync_mcn_inquiry_status → ingest_mcn_submissions → rank_creators → create_submission_batch → export_csv → record_client_feedback`

- 回收固定为 `sync → ingest → sync`；只有实际 MCP 返回算证据。`manual_source_creators` 仅是外发前可选补量，详情 Tool 仅核对事实。
- 搜索后展示 MCP 返回的供需与机构/手扒方案并确认；外发前重新查状态并按 Hook marker 确认。未确认不得推进。
- 精排必须同时具备真实外发成功、回收完成、`candidate_pool_enriched` 和动作授权；只有明确人工调整才 audit。

## 标准 Brief

宿主注入的 fast path、权威 preview、`currentLocalDateTime` 与 `timeZone` 是完整输入：不再读本 Skill/reference/resources/prompts。未决 gate 前业务 Tool 为 0（仅可用原生 `AskUserQuestion`）；`ready` 后首个业务调用固定为 `validate_requirement`，参数逐字复用 preview。

## 按需读取

- 新 Brief 异常：[`requirement-intake.md`](references/requirement-intake.md)、[`requirement-parsing.md`](references/requirement-parsing.md)、当前 [`tools/`](references/tools/) 卡片。
- 状态与失败：[`phase-tool-matrix.md`](references/phase-tool-matrix.md)、[`hook-behavior.md`](references/hook-behavior.md)、[`contract-gate.md`](references/contract-gate.md)、[`validation-playbook.md`](references/validation-playbook.md)。
- 交互与输出：[`ask-user-question-patterns.md`](references/ask-user-question-patterns.md)、[`form-field-mapping.md`](references/form-field-mapping.md)、[`frontend-response.md`](references/frontend-response.md)、[`mcp-tool-cheatsheet.md`](references/mcp-tool-cheatsheet.md)。

每次只读当前步骤需要的一张卡片；已有 `phase + allowed_actions` 时不读矩阵，标准 Brief 不读任何卡片。
