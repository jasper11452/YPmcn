# 执行门禁

## 契约与状态

以根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和运行时 schema 为准。每次业务 Tool 调用前先读 `tools/<tool>.json`；只传其中字段。Endpoint schema 优先；与目标导出契约冲突时返回 `integration_required`，不得自动回退。

会话状态写入 `state/confirmation_guard.json`。`phase/next_action` 是 Agent 编排权威；Provider 的 `workflow_state/allowed_actions` 只供事实或对账，不能覆盖本地 phase。状态只按实际成功响应推进。

## Human-in-the-loop

- `waiting_for="user"` 必须 Ask（或已选暂停），禁文字提问；非选项提示必须分行，选项不限。事实说明后若仍需人决定恢复、改参或下一步，必须同轮紧接 Ask，不得先用问句或选项停住等“继续”，每个弹窗至少保留一个宿主提供的用户自定义输入入口。其余 `next_action` 同轮续接。字段 callback 直接用，多平台不停；证据无效、未知写或 `integration_required` 且没有安全的人类决策分支时才直接报告停止。
- `search_creators` 成功后 `waiting_for=null`，直接执行 `rank_mcns`。`rank_mcns` 成功后统一进入“赛后补量” Ask；即使机构供给充足，也必须显示建议手动拓展 `0` 人和“机构承接达人:手动拓展达人”比例，并由用户确认是否继续。
- 企微发送与询价同步是两类独立证据。只有 `create_with_distributions` 的实际成功响应逐机构明确返回 `sent`，才写入发送成功状态；`sync_mcn_inquiry_status` 只能写同步状态和真实 inquiry ID，禁止新增、覆盖或推导 `sent_supplier_count`、发送明细或“已发送”结论。缺少前述发送证据时，sync 不得推进流程。
- sync 调用必须后于同需求、同项目、同机构集合的真实企微发送，并记录 `blocked_missing_matching_wecom_send / authorized_after_wecom_send / completed_after_wecom_send`。搜索链一旦启动必须完整经过排序、用户网页选字段、确认发送和 sync，之后才可拓展达人。
- 每次 `create_with_distributions`（包括批量失败后的每个单机构 fallback）必须先弹原生“企微外发确认”，并取得针对完全相同参数的“确认发送”。本地状态同步记录 `popup_required -> approved -> in_flight -> consumed`；缺少匹配的已弹窗、已确认回执时，after-tool 结果一律不得落为发送成功。

## 拓展达人导出链

1. 先确认完整需求和 `size`，且 `size` 必须匹配 `^[1-9][0-9]*$`。
2. 每次拓展达人前都重新解析完整 Brief 并调用 `validate_requirement`，省略旧 `id/demandVersion`，取得成功响应的 32 位 `data.id`。
3. 紧邻调用 `manual_source_creators({requirement_id,size})`，ID 等于第 2 步且只使用一次；格式错从现有响应纠正，不重新验证。宿主无会话上下文时由插件自有的一次性回执校验并消费。
4. 成功的非空达人列表是后续证据；立即展示固定五列表格并记录收到、展示状态。无企微返回 ID 就省略 `inquiry_id` 直接排序；否则从新到旧取首个有效 ID。当前流程有发送则弹“机构回填确认”，人工确认后合并排序、导出。

拓展达人可从任意 phase 发起，不检查历史库是否检索过该需求，也不检查其他流程是否完成；用户最新明确说“启动拓展”等启动/继续命令时直接进入该分支，仅缺必填值时 Ask。唯一调用门槛是紧邻需求解析的新 ID。禁止发送 `inquiry_id`、`target_count`、`run_id`、`limit` 或旧批次选项。

## 失败与恢复

- Hook 仅消费并核对本次拓展达人的新需求 ID，不用 phase、历史检索或其他流程完成度阻断；本地成功投影不等于 Provider 成功。
- 拓展达人写结果未知时先对账，禁止盲重试；无法取得权威结果且不存在安全的人类决策分支时报告停止；若需用户选择恢复方式，停止前必须先 Ask。
- 明确参数错误只修该字段；用户要求失败即停时绝不重试。
