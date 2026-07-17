# Hook 行为

Hook 是无会话依赖的安全守卫，不是业务状态机。

注册事件为 `before_tool_call`、`after_tool_call`、`session_end`；后者仅是可选清理机会。

## 调用前

- 对每个 YPmcn Tool 按机器契约校验 required、类型、禁止字段和语义约束。
- 阻断 shell/curl 绕过外发 API。
- 不要求 `sessionKey`，不使用本地 phase 授权业务动作。
- `create_with_distributions` 校验 supplier、未来带时区 deadline，并执行一次性确认握手。

## 一次性确认

`rank_mcns` 首次调用保存 10 分钟供给方案凭证，只包含请求 SHA-256、需求 ID 和平台。Ask 问题携带 supply-plan marker；只有“确认供给方案”把凭证改为 approved。全部 rank 参数绑定同一指纹，原参数只放行一次。

首次外发保存 10 分钟凭证，只包含请求 SHA-256、项目名、机构数、截止时间和字段数，不记录完整 payload。Ask 问题携带 confirmation marker；只有“确认发送”把凭证改为 approved。原参数只放行一次，成功后 consumed，结果未知后 unknown。

修改、拒绝、超时、凭证过期、请求参数变化或 Hook 看不到 Ask 结果时均不放行。

## 调用后

Hook 不推进数据库 phase。外发成功只消费确认凭证；外发结果未知则禁止盲目重试。业务状态由 MCP Service 从数据库派生并通过 `workflow_state/allowed_actions` 返回。

`session_end` 仅做机会性 TTL 清理；即使宿主从不触发，也不影响正确性。
