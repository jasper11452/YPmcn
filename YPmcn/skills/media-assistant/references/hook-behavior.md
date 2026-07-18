# Hook 行为

Hook 是无会话依赖的安全守卫，不是业务状态机。

注册事件为 `before_tool_call`、`after_tool_call`、`session_end`；后者仅是可选清理机会。

## 调用前

- 对每个 YPmcn Tool 按机器契约校验 required、类型、禁止字段和语义约束。
- 阻断 shell/curl 绕过外发 API。
- 不要求 `sessionKey`，不使用本地 phase 授权业务动作。
- `validate_requirement` 额外执行 Brief 业务门禁：平台、数量、截止、完整审计对象，以及 `kolOfficialPriceL1/L2/L3` 至少一项规范 `"[min,max]"` 且上界为正；所有范围字段同时校验格式、顺序和比例边界。
- `create_with_distributions` 校验 supplier、未来带时区 deadline；还要求 10 分钟内成功读取同一项目的 `get_workflow_state`，且其 `allowed_actions` 明确允许外发，之后才进入一次性确认握手。

## 一次性确认

`rank_mcns` 首次调用保存 10 分钟供给方案凭证，只包含请求 SHA-256、需求 ID 和平台。Ask 问题必须同时含十个固定 supply-plan 字段；字段齐全且答案精确为“确认供给方案”才把凭证改为 approved。全部 rank 参数绑定同一指纹，原参数只放行一次。

成功的 `get_workflow_state` 只留下 10 分钟安全摘要：项目名、查询身份、`allowed_actions`、时间与指纹；它只证明 Hook 看到了最新只读结果，不是本地业务状态，也不能替代数据库恢复。

首次外发保存 10 分钟凭证，只包含请求 SHA-256、项目名、机构数、截止时间、列名、固定企微模板 ID/hash 与 workflow-state 指纹，不记录完整 payload。Ask 问题携带 confirmation marker，并逐值展示这些安全字段；只有“确认发送”把凭证改为 approved。原参数只放行一次，成功后 consumed，结果未知后 unknown。

修改、拒绝、超时、凭证过期、请求参数变化或 Hook 看不到 Ask 结果时均不放行。

## 调用后

Hook 不推进数据库 phase。外发成功只消费确认凭证并清除短时状态摘要；外发结果未知则禁止盲目重试。业务状态仍由 MCP Service 从数据库派生并通过 `workflow_state/allowed_actions` 返回。

## 来源归因

先看结果 provenance，再描述责任方。`details.deniedReason="plugin-before-tool-call"`、`block=true` 且没有远程响应，表示本地 Hook 在调用前阻断，必须明确“未到达 MCP/Provider”。只有实际远程 MCP response 或 trace 证据存在时，才能称为 MCP/Provider 返回；没有 Hook 或远程证据时只写“来源未知”。Hook 的本地 confirmation receipt 只可拒绝，不可授权或推进 MCP 工作流；MCP 响应也必须同时提供可归属当前身份的 `workflow_state/allowed_actions` 才能推进。

`session_end` 仅做机会性 TTL 清理；即使宿主从不触发，也不影响正确性。
