# 需求入口

Brief 入口的第一条业务调用固定为 `validate_requirement`。调用前必须读取当前运行时 `inputSchema` 并完成本地参数预检；收到媒介输入后直接调用 `validate_requirement`，不得在调用前先向媒介确认拟传参数。

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

## 首次调用

收到媒介输入后直接调用 `validate_requirement`：

- 保留原始 Brief 到 `raw_messages`，不改写事实、不拆成 Agent 推断。
- 只发送运行时 schema 已声明字段；缺少 schema、工具缺失或 schema 冲突时停止并报告接入问题。
- 不得在调用前先向媒介确认目标工具、必填字段、拟传原文或消息角色。
- 已明确的 Brief 业务信息只随原文提交，不重复追问；ID、版本、run_id、inquiry_id 只能来自此前 MCP 成功响应。

**后续保护**: 该工具调用并非仅靠 Agent 自觉；运行时 `before_tool_call` 钩子会执行 `validateProtocolEnvelope` 基础类型校验 + `raw_messages` JSON 预解析，参数非法或不可序列化会被 `block` 阻断，不进入 MCP。([OpenClaw requireApproval] 类保护在 `create_with_distributions`/`rank_creators`/pending_gate 路径上启用，本节工具不在此列。)

## 结果处理

- `success=false`：展示错误摘要，停止。
- `success=true, status=draft`：只根据 MCP 返回的 `missing_fields`、`blocking_fields`、`clarifying_questions` 展示最多 3 个缺失必填项或语义模糊点，并按 `requirement-draft` 模式用 `askuserquestion` 弹窗让媒介补齐/暂缓/放弃；不自行推断缺失项。
- `success=true, status=ready`：展示结构化 brief 摘要（平台、数量、deadline、预算/内容要求、数据指标和表单字段影响），按 `confirm-structured-brief` 模式用 `askuserquestion` 弹窗等待媒介确认。确认后才调用 `search_creators`。
- 用户实质修改 Brief：无需先确认是否重新校验，追加新的原始消息后再次调用 `validate_requirement`；旧 ID/版本只使用 MCP 已返回的真实值。若修改影响后续不可逆动作，再用 `askuserquestion` 弹窗确认继续或暂停。

结构化需求由 MCP 在响应中返回并落库。Agent 不在请求中自行构造 `parsed_requirement`，也不因类目、金额或返点语义不确定而绕过 MCP。

## 版本冲突处理

当 `validate_requirement` 返回 `VERSION_CONFLICT` 错误（`success=false, error.code=VERSION_CONFLICT`）时，表示传入的 `existing_demand_version` 与服务端当前版本不一致。标准处理流程：

1. **停止当前操作**：不继续使用过时版本推进后续流程。
2. **展示冲突摘要**：告知媒介"需求版本已更新，需重新校验"，展示服务端返回的当前版本号（`server_demand_version`）。
3. **按 `askuserquestion`（`requirement-modify` 模式）询问**媒介下一步：重新校验 / 放弃本次修改 / 强制覆盖（需媒介明确授权）。
4. **媒介选择重新校验**：不传 `existing_demand_id` 和 `existing_demand_version`，仅携带原始 `raw_messages` 和补充内容重新调用 `validate_requirement`，获取最新版本。
5. **不可自动重试**：版本冲突表明服务端数据已被其他操作更新，盲目用旧版本覆盖可能导致数据丢失。

`VERSION_CONFLICT` 与一般的 `success=false` 不同——前者有明确的恢复路径（重新校验），后者通常是参数错误或服务异常，按错误摘要处理即可。
