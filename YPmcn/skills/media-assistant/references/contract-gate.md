# 契约门禁

生产调用前必须过以下 6 项门禁：

1. 调用前读取运行时 `tools/list`，并以仓库根 `spec/mcp.json` 为参数权威。
2. 必须逐项确认固定主链的 required tools 当前可调用；任一工具缺失、被过滤、required/type 不兼容或 ID 语义不明确时，立即停止并返回 `integration_required`。
3. `tools/list` 只证明能力存在，不证明业务步骤已执行。只有实际 MCP 返回可表述为完成。
4. 当前 Endpoint schema 优先于旧 mvp-v2；不跨 provider 混用 ID。
5. 本地 Hook 与测试结果不是生产成功证据。
6. 写结果未知时先查权威状态，不盲目重写。

开发 Provider 当前广告 15 个工具；当前演示包直接指向开发 SSE。没有公开向量工具。`tools/list` 未广告任何 `outputSchema`：除已实测的 `rank_mcns.data.mcn_run_id`、`rank_creators.run_id` 和字段选择 description 外，不得把旧输出字段当作契约。
