# 契约门禁

生产调用前必须过以下 6 项门禁：

1. 调用前读取运行时 `tools/list`，并以仓库根 `spec/mcp.json` 为参数权威。
2. 必须逐项确认固定主链的 required tools 当前可调用；任一工具缺失、被过滤、required/type 不兼容或 ID 语义不明确时，立即停止并返回 `integration_required`。
3. `tools/list` 只证明能力存在，不证明业务步骤已执行。只有实际 MCP 返回可表述为完成。
4. 当前 Endpoint schema 优先于旧 mvp-v2；不跨 provider 混用 ID。
5. 本地 Hook 与测试结果不是生产成功证据。
6. 写结果未知时先查权威状态，不盲目重写。

开发 Provider 当前广告既有 15 个业务工具；生产 SSE 暂未路由到业务 Provider。公开向量查询 `search_creator_tag_vectors` 仍在接入，只有运行时实际广告且输入兼容时才可用。`tools/list` 未广告任何 `outputSchema`：除工具描述明确说明的 `rank_creators` 的 `run_id` 和字段选择的 description 文本外，不得把旧输出字段当作契约。
