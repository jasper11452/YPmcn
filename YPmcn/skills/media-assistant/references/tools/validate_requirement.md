# validate_requirement

## 何时调用

Brief 首次进入、媒介补充缺失项、客户或媒介修改需求时调用。它是任何需求链路的第一条业务工具。

## 输入

只按运行时 `inputSchema` 传 `raw_messages`，以及 schema 明确允许时的 `project_context`、`existing_demand_id`、`existing_demand_version`。

## 输出成功证据

`success=true`，且 `data` 中有 `demand_id`、`demand_version`、`status`。`status=ready` 时还应有可展示的 `requirement_parsed` 摘要。

## 调用后必须停在哪里

`status=draft` 时停在补充缺失字段。`status=ready` 时停在结构化 brief 确认，展示平台、数量、deadline、预算/内容要求、数据指标、表单字段影响，用户确认后才进入 `search_creators`。

## 禁止

不得发送 `parsed_requirement`、`trace_id`、`idempotency_key` 或 gate 字段。不得为满足 ready 编造平台、数量、deadline、预算、内容要求或返点。
