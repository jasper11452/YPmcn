# 需求入口

Brief 入口的第一条业务调用固定为 `validate_requirement`。调用前必须读取当前运行时 `inputSchema`，通过文本交互（`pre-validate-requirement` 模式）向用户汇总拟传参数并等待确认。

## 当前请求边界

当前生产 schema：

| 字段 | 类型 | 必填 | 来源 |
|---|---|---|---|
| `raw_messages` | array[object] | 是 | 用户/媒介原始消息 |
| `project_context` | object 或 null | 否 | 用户明确提供的项目上下文 |
| `existing_demand_id` | string 或 null | 否 | 既有 MCP 成功响应 |
| `existing_demand_version` | integer 或 null | 否 | 既有 MCP 成功响应 |

不得发送 `trace_id`、`idempotency_key`、`parsed_requirement`、`parsed_requirement_draft` 或 gate 字段。它们不在当前请求 schema 中。

## `raw_messages`

- 保留原文，不把 Agent 推断伪装为客户事实。
- 每个元素使用对象；推荐包含 `role` 与 `content`。
- `role` 优先使用 `client`、`media`、`agent`、`system`。
- 用户原文用 `client`；媒介转述用 `media`；Agent 自我修正用 `agent`，不得伪装成 `client` 或 `media`。
- 只有原文确实提供时间时才带 `sent_at`；未知时省略或按运行时 schema 使用 null，不得用当前时间伪造。

示例：

```json
{
  "raw_messages": [
    {
      "role": "client",
      "content": "小红书找 10 个美妆博主，单账号预算 5000 元"
    }
  ],
  "project_context": {
    "project_name": "夏季新品"
  }
}
```

## 首次确认

> **机制标签**: 文本表格 — 所有 Agent 层用户交互的单一机制

调用前按 [用户交互模式](ask-user-question-patterns.md) `pre-validate-requirement` 向用户一次性确认：

- 目标工具：`validate_requirement`
- 当前必填：`raw_messages`
- 拟传原文和消息角色
- 可选上下文、旧需求 ID/版本是否使用

用户「确认调用」前不得调用。用户确认前不得调用任何业务工具；已明确的 Brief 业务信息只汇总，不重复追问。ID、版本、run_id、inquiry_id 只能来自此前 MCP 成功响应。

**后续保护**: 该工具调用并非仅靠 Agent 自觉；运行时 `before_tool_call` 钩子会执行 `validateProtocolEnvelope` 基础类型校验 + `raw_messages` JSON 预解析，参数非法或不可序列化会被 `block` 阻断，不进入 MCP。([OpenClaw requireApproval] 类保护在 `create_with_distributions`/`rank_creators`/pending_gate 路径上启用，本节工具不在此列。)

## 结果处理

- `success=false`：展示错误摘要，停止。
- `success=true, status=draft`：通过文本表格展示 MCP 返回的缺失字段或澄清问题（参照 `requirement-draft` 模式），不自行推断缺失项。
- `success=true, status=ready`：展示结构化 brief 确认表（平台、数量、deadline、预算/内容要求、数据指标和表单字段影响），等待媒介确认。确认后才调用 `search_creators`。`pre-validate-requirement` 的文本交互已覆盖调用授权，但 ready 后的结构化摘要仍需媒介确认以防止解析偏差。
- 用户实质修改 Brief：通过文本表格确认（参照 `requirement-modify` 模式），追加新的原始消息后再次调用 `validate_requirement`；旧 ID/版本只使用 MCP 已返回的真实值。

结构化需求由 MCP 在响应中返回并落库。Agent 不在请求中自行构造 `parsed_requirement`，也不因类目、金额或返点语义不确定而绕过 MCP。
