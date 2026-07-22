# 执行门禁

## 契约与状态

以根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和运行时 schema 为准。每次业务 Tool 调用前先读 `tools/<tool>.json`；只传其中字段。Endpoint schema 优先；与目标导出契约冲突时返回 `integration_required`，不得自动回退。

会话状态写入 `state/confirmation_guard.json`。`phase/next_action` 是 Agent 编排权威；Provider 的 `workflow_state/allowed_actions` 只供事实或对账，不能覆盖本地 phase。状态只按实际成功响应推进。

## Human-in-the-loop

- `waiting_for="user"` 必须 Ask（或已选暂停），禁文字提问；事实说明后若仍需人决定恢复、改参或下一步，必须同轮紧接 Ask，不得先用问句或选项停住等“继续”，每个弹窗至少保留一个宿主提供的用户自定义输入入口。其余 `next_action` 同轮续接。字段 callback 直接用，多平台不停；证据无效、未知写或 `integration_required` 且没有安全的人类决策分支时才直接报告停止。

## 拓展达人导出链

1. 先确认完整需求和 `size`，且 `size` 必须匹配 `^[1-9][0-9]*$`。
2. 每次拓展达人前都重新解析完整 Brief 并调用 `validate_requirement`，省略旧 `id/demandVersion`，取得成功响应的 32 位 `data.id`。
3. 紧邻调用 `manual_source_creators({requirement_id,size})`，ID 等于第 2 步且只使用一次；格式错从现有响应纠正，不重新验证。宿主无会话上下文时由插件自有的一次性回执校验并消费。
4. 只有实际成功响应中的唯一非空 `excel_file_path` 才是完成证据；原样提供文件入口并终止本链，不得调用 `select_inquiry_form_fields`、`rank_creators` 或 `create_submission_batch`。

拓展达人可从任意 phase 发起，不检查历史库是否检索过该需求，也不检查其他流程是否完成；用户最新明确说“启动拓展”等启动/继续命令时，该命令覆盖旧 `confirm_pre_race_supply`，不得重复弹供给确认，仅缺必填值时 Ask。唯一调用门槛是紧邻需求解析的新 ID。禁止发送 `inquiry_id`、`target_count`、`run_id`、`limit` 或旧批次选项。

## 失败与恢复

- Hook 仅消费并核对本次拓展达人的新需求 ID，不用 phase、历史检索或其他流程完成度阻断；本地成功投影不等于 Provider 成功。
- 拓展达人写结果未知时先对账，禁止盲重试；无法取得权威结果且不存在安全的人类决策分支时报告停止；若需用户选择恢复方式，停止前必须先 Ask。
- 明确参数错误只修该字段；用户要求失败即停时绝不重试。
