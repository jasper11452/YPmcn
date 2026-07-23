# MCP 现状与排障指南

> 适用版本：3.4.25。本文只写现在能确认的事实；未来服务端方案请看 [MCP + 数据库最小幂等与状态修正方案](MCP_DB_MINIMAL_IDEMPOTENCY_PLAN.md)。

## 先看结论

插件连接的是 https://mcp.eshypdata.com/sse。2026-07-23 的只读审计确认，远端有 15 个业务 Tool，但只公布了入参 Schema，**没有公布稳定的成功出参 Schema**。因此：

- 本地契约和 Tool reference 负责说明“可以传什么、何时能传”；
- 每次真实调用的返回值才是这一次业务结果的证据；
- 不能因为看到 success: true，就假定项目、企微消息或导出已经真的完成。

完整的实测入参、负向探测和差异记录在 [远程 MCP 工具运行时审计（2026-07-23）](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)。

## 现在能走到哪里

| 场景 | 当前行为 | 使用时要注意 |
| --- | --- | --- |
| 需求校验、搜索、MCN 排序 | 已有本地顺序和 ID 约束 | 只使用刚刚返回的 data.id，不要把 demand_id 当 Tool ID。 |
| 企微外发 create_with_distributions | 每次要实际外发前，先由本地 Hook 给出精确的 AskUserQuestion；确认后才一次性放行下一次调用 | 只有逐机构、可关联的明确 sent 状态才算发送成功；同步不能倒推出发送成功。 |
| 询价同步 sync_mcn_inquiry_status | 当前只能记录同步事实和实际返回的 inquiry ID | 它不能反过来证明企微已发送，也还不能代替完整回收链。 |
| 手工拓展 manual_source_creators | 支持 requirement_id + 字符串 size | 成功必须有非空达人数组；只有 Excel 路径不能作为“已拿到达人”的证据。 |
| 排序后的批次导出 | 当前阻断 | 远端和本地批准入参不一致，不能猜字段绕过。 |
| 用 Provider 恢复工作流 | 当前阻断 | 远端要 requirement_id，本地批准恢复身份却是 trace_id 或 demand_id + demand_version。 |

## 两个必须保持阻断的契约差异

### 1. create_submission_batch

本地批准的目标输入是：

~~~json
{"requirement_id":"<id>","size":"20","number":"1"}
~~~

远端实际要求的是 requirement_id、整数 size、submission_batche_page 和 columns。这里不只是字段改名：批次语义和列定义都缺少可靠映射。因此当前正确行为是返回 integration_required，而不是替 Agent 补一个 columns 或把 number 猜成页码。

### 2. get_workflow_state

本地恢复设计使用 trace_id，或 demand_id + demand_version；远端实际只接受 requirement_id。例如，手里只有 demand_id=1784... 时，不能凭猜测拼出 32 位 requirement ID 去查询。当前应保留本地状态并报告集成等待，等 Provider 发布批准的恢复入参后再启用。

## 外发：先确认，再调用；调用也不等于送达

`create_with_distributions` 是当前唯一的外发面。它不能用 shell、curl 等方式绕过；并且在真正调用 Provider 前，本地 Hook 会先拦住调用、返回**原样的** `AskUserQuestion` 参数。宿主必须直接展示这一个问题、换行和选项，不能自行改写或用一段普通文字代替。

一次外发的正确顺序是：

1. 首次调用 `create_with_distributions` 被本地拦截，Provider 此时尚未被调用；宿主展示“企微外发确认”。首次批量发送和每个逐机构 fallback 都各自需要这一步。
2. 用户明确选择“确认发送”后，最新且未过期的本地回执会跨 `AskUserQuestion` 的用户回调保留 10 分钟。
3. 回执只放行**下一次** `create_with_distributions` 一次，随后立即消费。当前实现不会再核对下一次调用的参数是否与弹窗时完全相等；这是为了兼容跨 turn 后宿主重建参数，不能把它理解成“以后都已获授权”。
4. 用户取消、拒绝、关闭弹窗、超时或回调失败时，Provider 不会被调用。没有宿主 session 上下文时，插件只使用自己的全局 fallback 回执，不会读取或借用别的 session 回执。
5. 调用返回后，再逐机构核对真实发送证据；只有明确 `sent` 的机构可进入后续 `sync_mcn_inquiry_status`。

举例：准备向 A、B 两家机构发询价时，先出现包含 A、B、回填字段和消息正文的确认弹窗。用户点“确认发送”后，即使回调发生在下一轮 assistant turn，最新未过期回执仍只允许一次 Provider 调用；第二次发送或对未绑定机构的逐个 fallback，都会重新弹确认。响应只写“发送成功”或返回聚合名单，仍不足以证明 A 已发送；必须有能与 A 对上的逐机构 `sent` 事实。若网络中断、响应丢失或状态不明，停止并保留证据，**不要盲目重发**。

## 手工拓展的当前规则

当前 Tool 入参是：

~~~json
{"requirement_id":"<刚校验得到的32位 data.id>","size":"12"}
~~~

其中 size 是正整数字符串，不是旧文档里的 target_count，也不是 JSON 数字 12。

有两条入口：

- 尚未开始 search_creators：可以直接走“校验需求 → 手工拓展”。
- 已经开始搜索：不能插队。必须先完成 MCN 排序、用户网页选字段、企微外发确认后的发送和与发送绑定的同步，之后才可手工拓展。

每次拓展前都要重新执行 validate_requirement，只把本次成功响应的 data.id 紧邻地用于一次 manual_source_creators 调用。成功后还要有非空的 creators、creator_list 或 manual_sourced_creators；只有 excel_file_path 时，不应报告“达人已入池”。

## 常见问题怎么查

| 现象 | 先查什么 | 不要怎么做 |
| --- | --- | --- |
| Tool 报缺少字段 | 对照远端 tools/list 和对应 references/tools/<tool>.json | 不要照旧文档补 target_count、run_id 等字段。 |
| success: false 但 MCP 请求本身没报错 | 看业务 envelope 的 error.code 和 trace_id | 不要把 MCP 通道成功当业务成功。 |
| 外发结果不明 | 保存实际响应、项目/机构关联信息，停止写入 | 不要自动重发外发 Tool。 |
| 想恢复旧会话 | 先看本地 JSON 编排状态 | 不要调用当前不兼容的 get_workflow_state，也不要由其他 ID 猜 requirement_id。 |
| Provider 对比失败 | 运行 npm run verify:provider，查看 schema diff | 不要为了让命令变绿而放宽本地批准契约。 |

## 最小排障命令

~~~bash
# 只读：初始化 MCP 并比较 tools/list；当前已知两项硬差异会使它返回非零
npm run verify:provider

# 本地 Plugin、Hook 与契约回归
npm run test:fast

# 文档生成区块是否仍与 Spec 同步
npm run verify:docs
~~~

如果需要写路径的成功样本，必须使用隔离测试需求、测试机构和可回收的企微通道，并在执行前确认清理方案。只读探测、Mock 或本地 Hook 回放都不能替代这类证据。
