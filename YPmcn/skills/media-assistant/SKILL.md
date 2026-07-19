---
name: media-assistant
description: "Use for YPmcn requirement validation, sourcing, distribution, ranking, submission, feedback, and recovery."
---

# YPmcn 媒介助手

业务读写只用已安装的 YPmcn MCP；批次成功后才可用宿主 `export_csv`。禁止 shell、curl、数据库直连、虚构结果或替代写接口。

## 执行规则

- 以根 `spec/manifest.json` 指向的正式契约和运行时 `tools/list` 为准；只传 live schema 声明的字段。必需 Tool 缺失、契约冲突或证据不足即 `integration_required`。
- `workflow_state` 与 `allowed_actions` 是状态权威。连续步骤复用实际成功响应；仅在接手、上下文丢失、冲突、写结果未知或不可逆外发前查询状态。
- 逐项核对 ID 血缘，只复制当前工作流中实际成功响应或已验证状态返回的 ID；不得猜测、串用或用虚构 ID 探测详情。
- 只有实际 MCP 返回算成功证据。`validate_requirement` 参数校验失败且用户已确认信息足以唯一修复时，保持原始需求语义，只修报错字段、序列化、映射或审计计数，并在同一轮持续重新调用直到成功；需要新增业务选择时才询问。普通服务失败不改参数、不换 Tool、不自动重试，写结果未知先对账；`recovered`、`closed` 后不得重复写入。
- Hook 只硬拦企微外发确认及其 shell/curl 绕过；其他 Tool 的参数、ID、顺序和动作授权以 MCP/Provider 返回为准，不把本地 Hook 当作业务状态权威。外发 Hook 阻断表示请求未到 Provider；没有远程证据时来源写“未知”。用户要求失败即停时绝不重试。

## 主链

`validate_requirement → search_creators → rank_mcns → 供给方案与 MCN 确认 → select_inquiry_form_fields → message 确认 → 可选 manual_source_creators → create_with_distributions → sync → ingest → sync → rank_creators → create_submission_batch → export_csv → record_client_feedback`

外发前应完成 supply、MCN、message 业务确认；Hook 只把最终 `create_with_distributions` 参数与一次性 Native Ask 回执绑定，不校验前序业务链。精排仍以 Provider 返回的真实外发、回收状态、`candidate_pool_enriched` 和动作授权为准。
宿主若注入标准 Brief preview，将其作为解析参考：未决值主动询问，完整后优先调用 `validate_requirement`，但 preview 不限制 Skill 读取或其他 Tool。
## 用户引导

用户首次使用时不知道要填什么。当用户输入太模糊（不满足 `isStandardBrief` 或解析出大量 `missing_required`）时，必须主动展示需求模板，**先输出这段模板再弹窗**：

```
请按以下模板补充需求信息（可复制粘贴修改）：

【平台】小红书 / 抖音
【达人数量】XX 位
【单达人预算】XX 元（告知是图文还是视频）
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

每次只读当前场景所需文件。
