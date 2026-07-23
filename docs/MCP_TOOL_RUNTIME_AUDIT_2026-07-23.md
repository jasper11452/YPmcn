# 远程 MCP 工具运行时审计（2026-07-23）

> 状态：运行时事实快照，不替代 [spec/mcp.json](../spec/mcp.json) 的批准契约。
>
> 目的：记录当前远程 Provider 实际发布的工具入参、可安全观察到的出参行为，以及与仓库契约的差异，供 Agent、插件和联调人员使用。

## 这份审计怎么用

把它当作“远端今天实际说了什么”的快照，而不是调用授权书：

- 想知道某个远端工具要求哪些字段，先查“远端实际入参目录”；再查包内工具卡，二者都满足才可以组装调用。
- 想知道某次失败是否安全，先分清是 MCP 参数层错误（`isError=true`）还是业务 envelope 的失败（MCP 调用成功但 `success=false`）。
- 想补齐成功出参、真实写入或企微外发证据，不能复用本文的假 ID probe；必须准备隔离测试对象、回收方案和明确授权。
- 本文的 probe 通过原始远端 MCP 会话执行，不经过本地插件的 `before_tool_call` / `after_tool_call`。因此它**不验证**当前仓库的企微外发确认实现；本地调用规则见下文“当前本地外发门禁”。
- 想判断能否上线，请结合[集成与上线就绪](integration-readiness.md)。本文只证明 2026-07-23 看到的 Provider 契约和安全负向行为。

例如，`rank_creators` 在远端 schema 中没有必填字段，并不等于可以空调用：它可能触发业务写入，所以本审计没有为“试一下”而调用它。

## 结论

- OpenCode 已成功连接远端 ypmcn-mcp；远端自报为 YP Local Business MCP 1.9.4，提供 15 个工具。
- 远端 tools/list 为所有 15 个工具发布了 inputSchema，但**没有**发布 outputSchema。因此，不能把成功出参当成有稳定 JSON Schema 的公共契约。
- 安全探测证明了两层错误语义：缺少必填参数时是 MCP 工具错误；参数形状合法但业务对象不存在时，MCP 调用可成功返回、业务 envelope 的 success 则为 false。
- 当前远端与批准契约有两项硬不兼容：create_submission_batch 和 get_workflow_state。两者仍应由插件 fail-close，禁止为联调而猜测或转换 ID/字段。

## 审计范围与方法

### 连接与来源

- 时间：2026-07-23 13:00 CST。
- OpenCode CLI：1.17.18。
- OpenCode 命令 opencode mcp list 在 YPmcn/ 下确认 ypmcn-mcp 已连接，地址为 https://mcp.eshypdata.com/sse。
- OpenCode 的 agent runner 因当前 OpenCode 账号没有可用计费方式而无法启动；这不是 MCP 连接失败。
- 因此，工具调用使用了 OpenCode 已解析的同一 YPmcn/.mcp.json SSE 地址建立标准 MCP 会话，并执行 initialize、tools/list 与下述安全 probes。没有替换 Endpoint、没有调用其他 Provider。该会话绕过了宿主和本地 Plugin Hook 生命周期，不能据此判断 `AskUserQuestion` 是否会出现、回执如何跨 turn 保存，或一次性授权是否正确消费。
- tools/list 的输入 schema 哈希为 e5fecf0057a8b705bc820957b01b3af53aa13aabc8a080090161cf40fc0241d5。

### 安全边界

- 未创建需求、项目、推荐、批次、反馈或人工调整；未发送企微消息；未读取任何真实客户、达人或推荐数据。
- 对有必填参数的写工具，只发送空对象，确认 Provider 在 Pydantic 参数校验阶段拒绝请求。
- rank_creators 的远端 schema 没有必填字段；空调用可能触发业务写入，因此没有为了探测而调用它。
- 只读路径使用全零或 opencode-audit-nonexistent 这类不可关联测试值；没有使用有效业务 ID。
- “业务写入/读取”分类来自本仓库的批准契约，不是远端 tools/list 的副作用声明。

## 当前本地外发门禁（3.4.25；不属于本次远端 probe）

下面是当前仓库中 Plugin Hook 的调用规则，来源是 `spec/workflow.json`、`spec/hooks.json`、`YPmcn/src/index.ts`、`YPmcn/src/runtime-hooks.ts`、`YPmcn/src/runtime-hook-workflow.ts` 与原生 Hook 回归测试；它是对 2026-07-23 远端快照的补充，不是本审计通过假 ID 得出的远端结论。

1. 每个要实际调用 `create_with_distributions` 的发送动作，包含首次批量发送和每个逐机构 fallback，都会先被本地阻断。Provider 尚未调用时，Hook 返回精确的 `AskUserQuestion` 参数；宿主必须原样展示，不能自行改写提示、换行或选项。
2. 只有用户明确选择“确认发送”，最新且未过期的回执才会跨 `AskUserQuestion` 的用户回调保留 10 分钟，并放行**下一次** `create_with_distributions` 一次。该调用后回执被消费。
3. 为兼容跨 turn 后宿主重建参数，当前实现放行这一次调用时不再核对参数是否与弹窗时等价。这不表示长期授权，也不会让同一回执放行第二次调用；下一次发送和每个 fallback 都要重新确认。
4. 用户取消、拒绝、关闭、超时或回调失败时，不调用 Provider。若宿主没有 session 上下文，插件只使用自己的全局 fallback 回执，绝不读取或授权 session 范围的回执。
5. 确认只是授权，不是送达证据。外发成功仍只能由 `create_with_distributions` 实际响应中、可关联到每家供应商的明确 `sent` 明细证明；`sync_mcn_inquiry_status` 只记录同步和 inquiry 事实，不能反推企微已发送。

例子：用户确认向 A、B 两家机构发送后，回调即使在下一轮 assistant turn 到达，也只允许一次 Provider 调用。若该批结果要求把 B 单独 fallback，再次调用 B 前会重新出现只针对 B 的确认；若原始响应丢失，则不自动重发。

## 远端实际入参目录

宿主调用名统一为 mcp__ypmcn__加下表 bare tool 名。表中“必填”与“可选”均来自 2026-07-23 的远端 tools/list，不是本地文件的推断。

| 工具 | 远端必填入参 | 远端可选入参与默认值 | 本地副作用分类 |
| --- | --- | --- | --- |
| select_inquiry_form_fields | platform：xiaohongshu 或 douyin | url：string 或 null，默认 null；timeout_seconds：integer，默认 600 | 只读，但会打开页面并等待用户回调 |
| validate_requirement | payload：object，允许额外字段 | 无 | 业务写入 |
| search_creators | id：string | 无 | 业务写入 |
| rank_mcns | id：string；platform：string | minimum_mcn_count：integer，默认 5；target_multiplier：number，默认 20；buffer_rate：number，默认 0.1；medium_risk_confirmation：object 或 null，默认 null；medium_risk_confirmed：boolean，默认 false；limit：integer，默认 20；write_mcn_recommendation_items：boolean，默认 true | 业务写入 |
| rank_creators | 无 | inquiry_ids：string[] 或 null，默认 null；requirement_id：string 或 null，默认 null | 业务写入 |
| create_submission_batch | requirement_id：string；size：integer；submission_batche_page：integer；columns：object[] | 无 | 业务写入，当前应阻断 |
| create_with_distributions | requirement_id：string；columns：object[]；supplierIds：string[] | description：string 或 null，默认 null；wechat_notification_message：string 或 null，默认 null | Provider 写入/外发 |
| ingest_mcn_submissions | inquiry_ids：string[] | 无 | 业务写入 |
| sync_mcn_inquiry_status | requirement_id：string；project_id：string；supplierIds：string[] | 无 | 业务写入 |
| manual_source_creators | requirement_id：string；size：string | 无 | 业务写入 |
| record_client_feedback | run_id：string；feedback_items：object[] | requirement_changes：object 或 null，默认 null | 业务写入 |
| audit_manual_adjustment | run_id：string；adjustments：object[]；operator_id：string | 无 | 业务写入 |
| get_creator_detail | platform：string；kwUid：string | include_offers：boolean，默认 true；include_mcn：boolean，默认 true；include_vector_text：boolean，默认 false；include_recent_metrics：boolean，默认 true | 只读 |
| get_recommendation_run_detail | run_id：string | include_submissions：boolean，默认 true；include_creator_detail：boolean，默认 false；include_feedback：boolean，默认 true | 只读 |
| get_workflow_state | requirement_id：string | 无 | 只读，当前应阻断 |

### 重要入参说明

- 远端对 columns、feedback_items、adjustments 与 medium_risk_confirmation 仅声明 object 或 object[]，没有发布内部字段 schema。调用方仍必须遵从包内 references/tools 下的更严格本地格式约束。
- rank_mcns 的 write_mcn_recommendation_items 默认 true。即使将它传为 false 在远端 schema 中合法，当前本地工作流也禁止这样调用，避免绕过推荐项落库与后续证据链。
- search_creators 远端只声明 id 为 string；插件另有更强语义约束：只能使用最近一次 validate_requirement 成功返回的 32 位 data.id，不能传 demand_id 或 demand_version。
- rank_creators 在远端 schema 层允许两个字段都省略或为 null，但本地工作流仍要求有当前轮 requirement_id 和上游有效证据；不能将“schema 可选”理解为“业务可自由调用”。
- get_recommendation_run_detail 虽发布为 string，安全 probes 对 run_id 为 0 或非数字字符串均收到“run_id 必须是正整数”的业务错误。因此当前可观察到的有效值语义是正整数字符串，未获得成功样本前不应进一步假设。

## 已观察到的出参与错误行为

### 1. 远端没有 outputSchema

所有 15 个工具的 tools/list 结果均未包含 outputSchema。下面的出参结论分为“实际观察”与“本地消费要求”两类；后者不是远端承诺。

### 2. MCP 参数错误与业务错误不是同一层

对下列工具以空对象调用时，MCP 结果为 isError=true、structuredContent=null，content 是 Pydantic 文本错误，并逐项指出缺失的必填参数：

- select_inquiry_form_fields
- validate_requirement
- search_creators
- rank_mcns
- create_submission_batch
- create_with_distributions
- ingest_mcn_submissions
- sync_mcn_inquiry_status
- manual_source_creators
- record_client_feedback
- audit_manual_adjustment
- get_creator_detail
- get_recommendation_run_detail
- get_workflow_state

这证明远端会在业务逻辑前校验上述必填字段，但不能证明字段值合法时的成功出参。

对四个可安全读取的路径，参数形状合法但目标不存在时，MCP 结果为 isError=false、structuredContent=null，文本内容是 JSON 业务 envelope。实际观察到的失败形状如下：

~~~json
{
  "success": false,
  "trace_id": "<runtime UUID>",
  "data": null,
  "error": {
    "code": "<business code>",
    "message": "<message>",
    "details": {}
  },
  "workflow_state": null,
  "allowed_actions": []
}
~~~

此 envelope 已在 search_creators、get_creator_detail 与 get_recommendation_run_detail 的安全失败路径上观察到；不应据此断言每个写工具都有完全相同的出参。

### 3. 多组合安全 probe 结果

| 工具 | 安全入参组合 | 实际观察 |
| --- | --- | --- |
| search_creators | id 为 32 位全零字符串；id 为短字符串 0 | 两者都返回 success=false、DEMAND_NOT_FOUND、data=null；远端没有在 schema 层强制 32 位格式。 |
| get_creator_detail | platform=xiaohongshu、未知 kwUid；关闭全部四个可选开关；platform=douyin、未知 kwUid | 三种组合都通过参数层，返回 CREATOR_NOT_FOUND，说明 xiaohongshu 与 douyin 至少在当前运行时被接受。 |
| get_creator_detail | platform=opencode-audit-invalid-platform、未知 kwUid | 返回 INVALID_PLATFORM，消息为“platform must be xhs or dy”。该消息与接受 xiaohongshu/douyin 的现象并存，故它不是完整 enum 契约。 |
| get_recommendation_run_detail | 非数字 run_id，默认开关；同一 ID 且三个开关均为 false；run_id=0 且三个开关均为 false | 都返回 RUN_NOT_FOUND，消息为“run_id 必须是正整数”，未泄露任何真实 run 数据。 |
| get_workflow_state | requirement_id 为 32 位全零字符串 | 返回 success=true，data.workflow_state=null、data.allowed_actions=[]、data.known_facts.resolved_requirement_id=null、data.recent_errors=[]；顶层 error=null。 |

### 4. 本地对成功出参的消费要求

这些要求来自 spec/mcp.json 和插件逻辑，用于防止把泛化 success 当成可继续工作流的证据；它们不是远端 outputSchema。

| 工具 | 继续工作流前必须保留/验证的实际成功证据 |
| --- | --- |
| validate_requirement | 保留完整实际响应；下游只使用实际返回的 32 位 data.id。 |
| search_creators | data.total_matched 与 data.supply_assessment；后者至少含 candidate_count、quantity_total、supply_multiplier、supply_risk_level、recommended_action。 |
| rank_mcns | inquiry_id、selected_supplier_ids、已选机构去重覆盖证据、倍率、风险档与 manual_sourcing_gap_count。 |
| select_inquiry_form_fields | 用户提交后的真实字段结果；不能自行生成 columns 或重复打开页面。 |
| create_with_distributions | 与请求 supplierIds 可关联的逐机构明确 sent 状态；通用 success 或聚合名单不能证明企微已发送。 |
| sync_mcn_inquiry_status | 仅可作为同步与 inquiry ID 证据，永远不能反推企微发送成功。 |
| manual_source_creators | 非空固定字段 creators、creator_list 或 manual_sourced_creators；可选 excel_file_path 不是达人行数据的替代品。 |
| rank_creators、create_submission_batch、record_client_feedback、get_recommendation_run_detail、get_creator_detail、audit_manual_adjustment、get_workflow_state、ingest_mcn_submissions | 远端未发布稳定成功 schema；必须保留该次实际响应，不能从工具名或本地假设补全字段。 |

## 远端与本地批准契约的差异

### 硬阻断：create_submission_batch

| 项目 | 远端实际 | 批准本地契约 |
| --- | --- | --- |
| 必填字段 | requirement_id、size、submission_batche_page、columns | requirement_id、size、number |
| size 类型 | integer | string |
| 批次字段 | submission_batche_page：integer | number：正整数字符串 |
| columns | 必填 object[] | 不存在 |

结论：没有安全映射。当前插件的 integration_required/fail-close 行为正确；不要为绕过阻断而猜测 submission_batche_page 或 columns。

### 硬阻断：get_workflow_state

| 项目 | 远端实际 | 批准本地恢复契约 |
| --- | --- | --- |
| 必填字段 | requirement_id | 无必填 |
| 接受的恢复身份 | requirement_id | trace_id，或 demand_id 加 demand_version |

结论：当前远端空状态响应不解决身份不兼容。不得从 trace_id 或 demand_id/demand_version 推导 requirement_id。

### 兼容但需继续收紧：create_with_distributions

- 远端将 description 与 wechat_notification_message 都接受为 string 或 null；本地要求实际外发正文以更严格格式传入。
- 远端 columns.items 是任意 object；本地要求每项只有非空 key 和 name。
- 这属于“本地输入是远端输入子集”的兼容差异，不等于远端已有正确业务语义或成功出参。

## 工具调用规则

1. 每次业务调用前读取对应的 YPmcn/skills/media-assistant/references/tools/<tool>.json；该文件给出 Agent 级语义、顺序、重试与禁止条件。
2. 只复制本轮真实成功响应或已验证本地状态中的 ID；不得拼接、猜测、复用跨需求 ID。
3. 对所有业务写入与外发工具执行 no-blind-retry。未知写入结果必须停止并保留原始响应证据。
4. 对 `create_with_distributions`，先让本地 Hook 返回并展示精确的 `AskUserQuestion`；只有“确认发送”的最新未过期回执才能放行下一次调用一次。取消、拒绝、关闭或超时不发送；逐机构 fallback 重新确认。
5. 对 `create_with_distributions`，只有逐供应商明确 `sent` 状态可证明发送；随后 sync 只能传这些实际 sent 的机构，sync 成功也不能反推发送成功。
6. create_submission_batch 与 get_workflow_state 在当前远端保持不可调用，直到 Provider 发布与批准契约一致的输入 schema。

## 获得正向成功出参所需条件

本审计刻意没有使用真实数据验证写路径。若需要补齐每个工具的成功 output 样本，必须提供一个隔离的可回收测试环境，并事先具备：

- 专用测试客户需求、测试供应商、测试达人和测试推荐 run；
- 可验证的 no-send 或沙箱企微通道；
- 针对每个写工具的清理/回收方案；
- 对 create_with_distributions、manual_source_creators、record_client_feedback、audit_manual_adjustment 等外部影响的明确授权；
- 原始 MCP 响应的脱敏归档方式。

在这些前提具备前，本文档中的安全负向 probe 和本地契约是唯一可审计的证据，不能被替换成“应该会成功”的推测。
