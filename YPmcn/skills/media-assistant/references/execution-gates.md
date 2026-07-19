# 执行门禁

## 契约与证据

先用运行时 `tools/list` 核对根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和错误契约。Endpoint schema 优先；不兼容即 `integration_required`。Tool 存在不等于步骤成功，Hook、Ask、示例、测试或 reference MCP 都不是生产证据。

每次写后只按实际返回的 `workflow_state + allowed_actions` 推进。写结果未知只能用 `get_workflow_state` 对账，禁止盲重试；本地确认不替代数据库幂等。`blocked/closed` 只执行返回允许的只读或修复动作。

需求身份来自 `validate_requirement`；`demand_id+demand_version` 只用于状态版本，`project_id+mcn_id+requirement_id` 绑定 distribution，`inquiry_id` 绑定回收，`run_id` 只来自精排或验证状态。达人/机构沿用实际 `kwUid/supplier_id`，不得猜 `creator_id/supplier_binding_id`。价格来自平台 `kolOfficialPriceL1/L2/L3`；需求返点不是机构实际返点。

## 人工门禁

`search_creators` 后的下一个 Tool 必须是原生 `AskUserQuestion`，不得先调用或试探 `rank_mcns`。确认弹窗必须使用以下固定格式——包含三个 【分区】、｜ 分隔、一行内（YP Action 会折叠换行）：

```
【真实数据】需求人数={demand_count}｜候选达人={database_candidate_count}｜供给倍数={supply_demand_ratio}
【推荐方案】目标提报={target_submission_count}｜预计有效={estimated_valid_return_count}｜预计缺口={estimated_gap_count}｜推荐MCN={recommended_mcn_count}｜MCN覆盖达人={mcn_covered_creator_count}｜人工补充={recommended_manual_creator_count}｜MCN人工比例={mcn_manual_creator_ratio}｜建议手扒占比={manualShare}%
【影响】确认后写入MCN排序
```

其中 `建议手扒占比` = `recommended_manual_creator_count / (mcn_covered_creator_count + recommended_manual_creator_count) * 100%`，必须展示。十项字段均来自 `search_creators` 返回后的 AI 计算：`supply_demand_ratio` = 候选数/需求数；`estimated_gap_count` = max(0, 目标提报-预计有效)；`recommended_manual_creator_count` = max(ceil(需求数*20%), 预计缺口)；`mcn_manual_creator_ratio` = MCN覆盖达人:人工补充。缺项即停止，禁止从分页、候选数组长度或”约 N+”文案估算。标题固定为”供给确认”，选项固定为”确认供给方案 / 调整方案”。Hook 会把精确匹配当前搜索结果的首次弹窗绑定到内部 marker。只有答案精确为”确认供给方案”才可调用最小参数 `rank_mcns({id, platform})`；随后等待用户确认实际 MCN 列表。

选择询价字段后展示实际 description、机构名单和固定消息预览。外发前重新查询同一项目状态并确认动作授权；supply、MCN、message 三项确认必须由 `confirm_distribution_send` session action 记录。首次外发 Hook 返回的 marker 和绑定摘要必须原样展示，只有“确认发送”才以完全相同参数继续；修改、拒绝、超时、过期或参数变化均重新确认或停止。session action 不可用时返回 `integration_required`，不得自行设计替代接口。

## 工具边界与恢复

- `search_creators` 只查现有库，不开浏览器或外搜。`manual_source_creators` 只在外发前导入已关联当前需求的真实人工结果，不能替代外发和回收。
- 外发成功后按实际返回身份执行 `sync → ingest_mcn_submissions → sync`；无真实回收 items 不 ingest，不轮询。只有真实外发、全部回收和 `candidate_pool_enriched` 才可 `rank_creators`。
- 详情 Tool 只读且不推进流程；`audit_manual_adjustment` 仅用于有操作者和原因的明确人工调整。批次成功后才导出；客户有具体反馈后才记录，不猜状态。

Hook 的 `before_tool_call`、`after_tool_call`、`session_end` 只做无会话依赖的安全守卫，不推进数据库 phase，也不记录完整 payload。任何 `block=true` 或 `details.status="blocked"` 都立即停止；只有实际远程 response/trace 才能归因 MCP/Provider。
