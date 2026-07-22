---
name: media-assistant
description: "Use for YPmcn requirement parsing, manual creator sourcing, auditable list display, ranking, and submission export."
---

# YPmcn 媒介助手

只用已安装的 YPmcn MCP 完成需求解析、拓展达人和可选导出；禁止 shell、curl、数据库直连、虚构结果或替代写接口。

## 执行规则

- 开始前取得完整需求和拓展达人数量 `size`；`size` 是正整数十进制字符串，缺值不猜。
- HITL：仅 `AskUserQuestion` 收集输入；只问未决必填/歧义、证据分支、外发或安全恢复，一次问全。弹窗问题的非选项提示必须分行，禁止单行展示；选项不限。凡说明事实后仍需人决定，须同轮立即 Ask，不得以问句、选项或邀请聊天回复结尾后停下，且每个弹窗保留用户自定义输入入口。其余 `next_action` 自动续接；提交即执行，取消即停，禁索要“继续”。
- Nonterminal output is Tool calls only; final text is allowed only at an allowed stop.
- Allowed stops: terminal, Provider wait, terminal failure without safe recovery, or cancelled Ask. Otherwise continue; a human decision requires Ask first. After cancellation, wait for a new user message.
- 标准检索链中，`search_creators` 成功后同轮直接调用 `rank_mcns`，中间不弹供给确认、不询问是否继续。排序成功后才弹“赛后补量”：始终展示需求人数、已选机构数、预估机构达人去重覆盖量、供需倍数、建议手动拓展人数，以及“机构承接达人:手动拓展达人”比例；手动拓展为 `0` 时也必须显示（例如 `2:0`），并且不得发起零人拓展。响应含真实累计覆盖里程碑时，同时展示前 N 家可达到的实际供需倍数，禁止虚构。
- 字段选择网页只允许用户操作。每轮 MCN 流程最多调用一次 `select_inquiry_form_fields`，调用后等待用户在网页选择并提交；禁止代选、预选、推断或提交字段，也禁止在等待、成功、取消、超时或无效 callback 后重复打开网页。
- `sync_mcn_inquiry_status` 只允许在本轮 `create_with_distributions` 实际成功响应逐机构返回匹配需求、项目和机构集合的 `sent` 明细后调用；状态机记录授权、阻断和完成顺序。sync 只证明询价同步，绝不证明企微已发送。
- 每次 `create_with_distributions` 实际发送前（包括逐机构 fallback）都必须弹出原生“企微外发确认”，且仅在用户对完全相同参数明确选择“确认发送”后执行。状态机必须依次记录 `popup_required/approved/in_flight/consumed`；没有匹配的“已弹窗且已确认”回执时，即使收到 after-tool 成功结果也不得记为企微发送成功。If host context disappears after external approval, accept only one exact unexpired local confirmation receipt; zero or multiple matches fail closed.
- 多平台依原文、同平台依差异字段拆单；各单继承共享字段，共用 Ask，不问先后或中途停。
- 切单时本地记 suspended/resumed/completed、next_action 及逐单事件；禁依赖 Provider 状态。
- rank_mcns 后 Ask 正文保留换行，超 40 个 Unicode 字符换行。
- Endpoint schema 优先，并与根 `spec/manifest.json` 指向的正式契约核对；必需 Tool 缺失、契约冲突或证据不足即 `integration_required`，不得回退旧参数。
- 每次调用前先读 `references/tools/<tool>.json`，只传其中字段；只有实际 MCP 成功响应才是后续证据。
- 未启动 `search_creators` 时可直接拓展达人；一旦启动搜索，必须完整走完 `rank_mcns → 用户网页选字段 → 企微确认与发送 → sync`，不得中途跳到拓展达人。每次拓展仍先按 `requirement-intake.md` 解析并成功调用 `validate_requirement`，只把新生成的 32 位 `data.id` 用于紧邻的一次调用。
- 除上述当次新 ID 外，不检查该需求是否历史检索过或其他流程是否完成。其余 ID 仍逐项核对 ID 血缘，只复制本轮实际成功响应返回的 ID；不得猜测、串用或用虚构 ID 探测。
- 任一步失败都停止后续业务 Tool；必需证据无效不算成功。写结果未知时先对账，禁止盲重试；用户要求失败即停时绝不重试。
- 主键格式错就改用当前响应的 `data.id`，不得再建需求；Hook 缺少宿主会话上下文时由插件自有的一次性回执完成校验，不得重新建需求。不得把 `DEMAND_NOT_FOUND` 猜成去重、清理、覆盖或延迟。
- Hook 校验原始 Brief、搜索/拓展达人的 `data.id` 与企微外发；先剥离包装，Ask/Tool JSON 不覆盖原文。拓展达人绑定一次性新 ID，但不以 phase 或历史为门槛。重复 `rank_creators` 只提示。本地状态只按实际成功结果推进，preview 不限制 Skill 读取或其他 Tool。

## 主链

`validate_requirement → manual_source_creators → 列表展示 → rank_creators → create_submission_batch`

1. 紧接拓展达人前重新解析完整需求并调用 `validate_requirement`；新建参数不得携带旧 `id/demandVersion`，也不要自动插入 `search_creators`。多平台拆分时，各 payload 的 `originalBrief` 都保留同一份完整客户原文，非当前平台条款作为 atom 保留，禁止添加去重标记。
2. 仅用第 1 步实际成功响应新生成的 ID 调用 `manual_source_creators({requirement_id,size})`；该 ID 用后即失效，禁止发送 `inquiry_id`、`target_count`。
3. 成功响应必须返回非空达人列表；立即按固定字段展示 Markdown 表格：平台、达人ID、达人昵称、内容标签、主页链接。状态机按调用批次分别记录数据已收到与列表已展示，不保存原始达人行。
4. 无企微发送返回 ID 时省略 `inquiry_id`，直接 `rank_creators` 并生成提报表；否则按发送调用从新到旧取首个有效 ID。当前流程有发送时，sync 后弹“机构回填确认”；只有人工选择“确认已完成回填”才合并排序，ID 本身不证明回填。

直接拓展时，`validate_requirement` 与 `manual_source_creators` 之间不得插入其他业务 Tool。搜索链已启动时，必须先完整完成 MCN 链，再进入这段直接拓展与合并排序。

## 按需读取

- 状态、确认、恢复：[`execution-gates.md`](references/execution-gates.md)
- 字段转换：[`form-field-mapping.md`](references/form-field-mapping.md)
- 回复格式：[`frontend-response.md`](references/frontend-response.md)
- 每次拓展达人前的 Brief 解析：[`requirement-intake.md`](references/requirement-intake.md)
- 每个 Tool 的调用格式：[`references/tools/`](references/tools/)

每次只读当前场景所需文件。
