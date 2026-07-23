# 当前集成与上线状态

> 更新：2026-07-23 · 插件包版本：3.4.25
>
> 面向对象：需要判断“现在能不能接真实业务”的产品、研发、测试和交付同学。
>
> 结论：**目前不能上线（NO-GO）。**

这份文档说的是“今天有哪些证据”，不是对未来能力的承诺。仓库的批准契约基线为 `mvp-v2`，但契约、插件代码和远端服务是三层不同的事实：本地测试通过或远端能列出工具，都不等于真实业务链路已经验收。

## 一句话结论

本地契约和插件编排已经具备可测试的基础；远端 MCP 也能连接并列出 15 个业务工具。可是，当前远端工具的两个关键入参仍和仓库批准契约不兼容，且没有发布稳定的成功出参 schema。再加上服务端幂等、恢复和端到端写入尚未完成实证，因此不能把本地测试通过或工具“看得到”当作可以上线。

## 当前状态一览

| 方面 | 当前状态 | 已验证的事实 | 还不能据此推出什么 |
| --- | --- | --- | --- |
| 正式契约 | 已批准 | `spec/manifest.json` 的基线为 `mvp-v2`；需求契约已批准。 | 契约批准不代表远端已经实现。 |
| 本地插件 | 可运行、有限门禁 | `YPmcn/src/index.ts` 注册了 `before_prompt_build`、`before_tool_call`、`after_tool_call`、`session_end` 四个 Node Hook。 | 本地确认只控制插件放行一次调用；不能替代服务端事实、权限或写入结果。 |
| 远端 MCP | 可连接，但契约不兼容 | 2026-07-23 实测 endpoint 可列出 15 个工具。 | “能列出工具”不等于输入、输出和写入行为正确。 |
| 数据库 | 开发环境观察过 | `spec/database.json` 标记为 `development-observed`。 | 这不是迁移、部署、并发或生产验收的证明。 |
| 排序算法 | 未完成外部验证 | `spec/algorithms.json` 标记为 `external-unverified`。 | 不能把现有向量组件的局部行为当成正式业务排序规则。 |
| 生产就绪度 | **NO-GO** | `spec/requirements.json` 明确标记 `productionReadiness: NO-GO`。 | 不应接入真实生产流量或把写入结果当作已交付。 |

## 已确认的阻塞点

### 1. 两个工具的入参不能安全兼容

实时 Provider 检查目前为 **FAIL**。不是网络问题，而是远端 `tools/list` 广告的输入 schema 与本地批准契约存在硬差异：

| 工具 | 远端当前要求 | 本地批准契约 | 为什么必须停住 |
| --- | --- | --- | --- |
| `create_submission_batch` | `requirement_id`、整数 `size`、`submission_batche_page`、`columns` | `requirement_id`、字符串 `size`、`number` | 不知道远端的页码和列结构如何从本地语义安全推导，不能靠猜字段继续。 |
| `get_workflow_state` | `requirement_id` | `trace_id`，或 `demand_id + demand_version` | 不能从其他身份标识“猜”出 requirement ID；猜错会查询或恢复到错误业务。 |

因此，当前插件会对这两个工具 fail-close。示例：达人排序完成后，不能为了导出而临时塞一个 `submission_batche_page`；应报告集成等待，直到 Provider 发布与批准契约一致的输入。

完整实测输入、错误层级和安全探测结果见 [远程 MCP 工具运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)。

### 2. 远端没有承诺成功出参格式

15 个工具都发布了 `inputSchema`，但没有 `outputSchema`。这意味着调用方可以知道“怎么传”，却不能把一次看起来像 `success` 的文本当作稳定数据接口。

例如，`create_with_distributions` 只有在实际响应里逐个供应商明确给出可关联的 `sent` 结果时，才能记录“已发送”。一个笼统的成功提示、后续 `sync_mcn_inquiry_status` 的结果，或本地 Hook 的状态，都不能证明企微已经发出。

### 3. 写入后的恢复与幂等仍缺服务端证据

当前本地状态只用于 Agent 编排和本地调用门禁：它可以在人工确认后让插件放行一次 MCP 调用，但不会给 Provider 授权，也不能把未知写入变成成功。`spec/database.json` 仍列出未实现或未远端验证的服务端不变量，包括持久化幂等账本、MCN 询价关联和选中机构覆盖快照。

例如，外部创建请求如果已经到达服务端但响应丢失，正确做法是停止并对账；不能再次调用同一个写工具碰碰运气。

## 当前流程怎样理解

### 直接拓展达人

在尚未开始搜索的情况下，可按下面的最小链路执行：

1. 调用 `validate_requirement`，取得本次真实成功响应中的 32 位 `data.id`。
2. 紧接着调用 `manual_source_creators({ requirement_id: data.id, size: "20" })`。
3. 只有实际返回非空达人列表，才进入后续排序。

这个 ID 只可用于紧邻的一次拓展调用；不能改用 `demand_id`，也不要复用旧会话里的 ID。若已经开始 `search_creators`，则必须先完成 MCN 分支、字段选择、发送和发送后同步，才能转入人工拓展。

### 对外发送

`create_with_distributions` 不是“点了就发”。每一次调用尝试（包括单个供应商的兜底重发）都会先被本地 Hook 阻断，并弹出固定语义的“企微外发确认” `AskUserQuestion`。只有用户明确选择“确认发送”，插件才会保存本次确认；取消、拒绝、关闭、超时或弹窗本身报错，都不会继续调用 Provider。

确认是跨对话回合的一次性本地回执：最新且未过期的回执可在后续回合放行**下一次且仅一次** `create_with_distributions`。本地工作流投影会记录 `popup_required`、`approved`、`in_flight`、`consumed`；宿主没有提供会话上下文时，插件改用自己的无会话全局回执，不借用任一会话的回执。当前实现不会因为后续调用参数变化而重新比对或自动弹出确认框，因此业务流程若修改收件机构或文案，不能假定参数变化会带来新的确认。

这层确认只证明“人同意插件尝试调用”，不证明企微已送达。只有 Provider 的实际成功响应里逐个供应商给出可关联的 `sent` 明细，才能记录“已发送”；`sync_mcn_inquiry_status` 只能说明同步/询价事实，不能当作发送证据。结果未知时仍必须停止并对账，不能盲重试。

## 如何验证，而不是凭文档下结论

| 想确认什么 | 命令 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 人类文档是否与自动生成区块一致 | `npm run verify:docs` | Skill、按需引用和文档一致性检查通过。 | 远端服务可用。 |
| OpenClaw 插件、契约与 Native Node Hook | `npm run test:fast` | TypeScript 插件、契约守卫，以及外发确认的一次性回执/拒绝路径等本地行为通过。 | 真实 Provider 写入成功或企微送达。 |
| 当前远端广告契约（provider checker） | `npm run verify:provider:prod` | 对真实 SSE endpoint 做 `initialize` 与 `tools/list` 的只读检查。 | 任何业务写入、企微发送或 E2E 成功。 |
| 完整离线检查 | `npm run verify` | 当前 checkout 的 Spec、打包、测试和文档一致性。 | 已部署环境和生产数据正确。 |

截至本次更新，第三项会因上面的两处 schema 差异报告失败；这是需要修复的当前事实，不应通过放宽本地校验绕过。

旧 Python Hook 状态机已从当前验收门禁移除；它们只保留为历史回归工件，不能用来证明当前 Node 插件或服务端工作流已经恢复。

## 从 NO-GO 到 GO 的最小条件

1. Provider 为 `create_submission_batch` 与 `get_workflow_state` 部署并发布批准的输入契约，检查器重新通过。
2. 对关键写工具补齐服务端幂等、未知结果对账和可恢复的权威状态。
3. 在隔离测试数据与无真实外发影响的通道中，保留一次完整链路的原始证据：需求校验、搜索/MCN 或人工拓展、排序、外发确认、发送、同步、回收和新会话恢复。
4. 用当日部署环境重新核对数据库约束与算法版本，而不是沿用旧报告或旧 trace。
5. 完成凭据轮换、发布包检查和受控灰度后，才由负责人将状态改为 GO。

## 事实来源与阅读顺序

1. [远程 MCP 工具运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)：远端 2026-07-23 的只读实测快照。
2. `spec/mcp.json`、`spec/workflow.json`：批准的工具与流程契约。
3. `spec/database.json`、`spec/algorithms.json`、`spec/requirements.json`：数据库、算法和生产就绪度边界。
4. `YPmcn/src/index.ts`、`YPmcn/src/runtime-hooks.ts`：当前 Node 插件的实际行为。

旧联调日期、旧版本号和历史 trace 只可用来定位复测线索，不能覆盖本页的当前状态。
