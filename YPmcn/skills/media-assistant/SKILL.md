---
name: media-assistant
description: "Use for YPmcn requirement validation, sourcing, distribution, ranking, submission, feedback, and recovery."
---

# YPmcn 媒介助手

业务读写只用已安装的 YPmcn MCP；批次成功后才可用宿主 `export_csv`。禁止 shell、curl、数据库直连、虚构结果或替代写接口。

## 执行规则

- Endpoint schema 优先，并与根 `spec/manifest.json` 指向的正式契约核对；只传 live schema 字段。必需 Tool 缺失、契约冲突或证据不足即 `integration_required`。
- 本地 `state/confirmation_guard.json` 的 `workflow.phase/next_action` 是编排权威；Provider 状态只作业务事实与未知写对账，不得覆盖本地 phase。连续步骤复用实际成功响应。
- 逐项核对 ID 血缘，只复制当前工作流中实际成功响应或已验证状态返回的 ID；不得猜测、串用或用虚构 ID 探测详情。
- 只有实际 MCP 返回算成功证据。`validate_requirement` 参数校验失败且用户已确认信息足以唯一修复时，保持原始需求语义，只修报错字段、序列化、映射或审计计数，并在同一轮持续重新调用直到成功；需要新增业务选择时才询问。普通服务失败不改参数、不换 Tool、不自动重试，写结果未知先对账；`recovered`、`closed` 后不得重复写入。
- 每次调用前必须先读 `references/tools/<tool>.json`。Hook 只硬拦 shell/curl 外发绕过，并用 Native Approval 警告绑定原始企微调用；其他 Tool 不做严格门禁。本地状态只按实际成功结果推进；没有远程证据时来源写“未知”。

## 主链

`validate_requirement → 自动 search_creators → 固定供需结果与用户确认 → rank_mcns 赛马 → MCN 确认 → select_inquiry_form_fields → 可选 manual_source_creators → Native Approval 后 create_with_distributions → sync → ingest → sync → rank_creators → create_submission_batch → export_csv → record_client_feedback`

任一弹窗的已提交选择都是执行指令，必须同轮继续所选动作，不能只回复已确认。企微 Tool 只传 live key `requirement_id`、`supplierIds`、`columns` 和需求整理出的 JSON 字符串 `description`；业务说法 `requirement_ID/colums` 不可作为参数名。Native Approval 确认后宿主自动续传原调用。
宿主若注入标准 Brief preview，将其作为解析参考：未决值主动询问，完整后优先调用 `validate_requirement`，但 preview 不限制 Skill 读取或其他 Tool。
## 用户引导

用户首次使用时不知道要填什么。当用户输入太模糊（不满足 `isStandardBrief` 或解析出大量 `missing_required`）时，必须主动展示需求模板，**先输出这段模板再弹窗**：

```
请按以下模板补充需求信息（可复制粘贴修改）：

【平台】小红书 / 抖音
【达人数量】XX 位
【单达人预算】XX 元（小红书选图文/视频；抖音选1–20秒/21–60秒/60秒以上）
【返点要求】XX%（可选）
【账号类型】母婴 / 美妆 / 美食 / 穿搭 / 科技 / 其他
【提报截止】X月X日 XX:XX
【发布档期】X月X日 - X月X日（可选）
【内容要求】图文为主 / 视频为主 / 其他
```

用一次 AskUserQuestion 收集缺失字段，每题聚焦一个字段，选项覆盖常见值 + "其他"供自由输入。

## 按需读取

- Brief 解析：[`requirement-intake.md`](references/requirement-intake.md)
- 状态、确认、恢复：[`execution-gates.md`](references/execution-gates.md)
- 询价字段：[`form-field-mapping.md`](references/form-field-mapping.md)
- 回复格式：[`frontend-response.md`](references/frontend-response.md)
- 每个 Tool 的调用格式：[`references/tools/`](references/tools/)
每次只读当前场景所需文件。
