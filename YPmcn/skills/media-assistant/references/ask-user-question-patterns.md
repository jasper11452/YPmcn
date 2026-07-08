# 用户交互模式

本文档是本插件所有 Agent 层用户交互的单一可信源。凡是需要媒介确认、选择、授权或承担风险的暂停点，必须使用 `askuserquestion` 工具发起弹窗；Brief 原文进入 `validate_requirement` 前不弹窗确认。

## 核心原则

- **先调用校验工具**：媒介输入、补充或修改需求后，先直接调用 `validate_requirement` 解析和验证。
- **入口不确认**：不要在 `validate_requirement` 调用前弹窗确认。
- **确认才弹窗**：只有需要媒介做决定时使用 `askuserquestion`；纯信息展示直接短回复。
- **正文承载事实，弹窗承载决定**：候选列表、风险原因和结构化 brief 摘要可以先在聊天正文中简短展示，弹窗只放问题和选项。
- **确认后立即执行**：媒介在弹窗中选择确认/继续后，立即调用对应业务工具，不二次询问。
- **取消即停止**：媒介选择取消、拒绝或暂缓后停止，不自动选择备选方案。
- **不泄露内部信息**：弹窗和正文都不展示 trace_id、完整 JSON、内部状态字段、数据库 ID 或算法细节。

## 弹窗字数限制

`askuserquestion` 弹窗必须短，避免内容被截断或选项看不清：

- `title`：不超过 16 个中文字符。
- `question`：不超过 60 个中文字符，只问一个问题。
- `options`：最多 3 个选项；选项互斥、覆盖主要路径。
- 选项 `label`：不超过 8 个中文字符。
- 选项说明：不超过 30 个中文字符，说明选择后的动作或风险。

如信息超过上述限制，先在聊天正文给摘要，再用弹窗问决策。不要把完整 MCN 列表、完整 brief、完整企微消息塞进弹窗。

## 何时暂停

| 场景 | 示例 | 交互方式 |
|---|---|---|
| 解析后需要补齐或澄清 | 缺平台、数量、截止时间或预算语义不清 | 正文列最多 3 项，弹窗选择补充/暂缓/放弃 |
| 确认解析结果 | 结构化 brief ready | 正文摘要，弹窗确认/修改/取消 |
| 发送或创建不可逆动作 | 发送企微询价、创建提报批次 | 弹窗确认/修改/取消 |
| 风险接受 | 中风险 MCN、风险账号提报 | 弹窗接受/剔除或拒绝 |
| 多路径选择 | 供给不足、是否手扒或放宽 | 弹窗最多给 3 条主要路径 |

## 弹窗选项规则

- 选项互斥：不要同时出现「确认」和「继续」这类同义选项。
- 选项可执行：每个选项都对应明确下一步工具调用、暂停或取消。
- 选项有边界：不可逆动作的说明中标明「不可逆」。
- 超过 3 条路径时合并为「按建议继续」「调整后继续」「取消/暂缓」三类。
- 列表选择先在正文展示编号，弹窗只问「按当前选择继续 / 重新选择 / 取消」。

## 交互点索引

| ID | 阶段 | 触发条件 | 决策内容 | 确认后动作 |
|---|---|---|---|---|
| `requirement-draft` | requirement | `validate_requirement` 返回 `status=draft` | 补齐缺失必填项或澄清语义模糊点 | 携带补充消息重新调用 |
| `confirm-structured-brief` | requirement | `validate_requirement` 返回 `status=ready` | 确认平台、数量、deadline、预算/内容、数据指标和表单字段影响 | 调用 `search_creators` |
| `confirm-filter-metrics` | candidate_pool | `search_creators` 成功后 | 确认数据字段和筛选口径（平台候选数、粉丝范围、报价区间等） | 调用 `rank_mcns` |
| `confirm-supply-ratio` | mcn_planning | `rank_mcns` 成功后 | 确认 MCN 与野生比例、是否需要手扒 | 进入 MCN 名单确认 |
| `mcn-select-for-wechat` | mcn_planning | 比例确认后 | 确认已选择的 MCN 机构范围 | 进入表单字段确认 |
| `confirm-form-fields` | mcn_planning | MCN 名单确认后 | 确认回填表单字段能否覆盖 brief 要求 | 进入企微权限 gate |
| `confirm-wecom-permission` | distribution | 表单字段确认后 | 企微角色权限 gate（仅媒介/采购） | 进入消息内容确认 |
| `mcn-wechat-send` | distribution | 权限 gate 通过后 | 确认企微消息文本内容和发送对象 | 调用 `create_with_distributions` |
| `proceed-to-ranking` | distribution | `create_with_distributions` 成功后 | 是否进入达人精排 | 调用 `rank_creators` |
| `confirm-medium-risk` | mcn_planning | `rank_mcns` 含中风险 MCN | 接受中风险继续 | 调用 `rank_mcns`（`medium_risk_confirmed=true`） |
| `confirm-risky-submission` | submission | `create_submission_batch` 含 `need_confirm` 账号 | 接受风险账号提报 | 调用 `create_submission_batch`（`allow_need_confirm_with_risk=true`） |
| `status-recovery` | 任意 | 用户询问当前状态 | 展示当前阶段并选择下一步 | 按选择推进或等待 |
| `requirement-modify` | requirement | 用户实质修改 Brief | 重新校验后的下游继续/暂停选择 | 需要时调用对应下一步 |
| `insufficient-supply` | candidate_pool | `search_creators` 供给不足 | 手工补量、放宽筛选或按现有结果继续 | 调用对应工具 |

`validate_requirement` 返回 `status=ready` 后必须停在结构化 brief 确认，不自动连续调用 `search_creators`；`rank_mcns` 后必须依次完成比例、机构名单、表单字段和企微权限四步确认。

## 模式定义

### 1. `requirement-draft` — 需求不完整

触发：`validate_requirement.success=true, status=draft`。

正文先说：需求已记录，但还需补齐以下信息后才能继续。只列 MCP 返回的缺失必填项和澄清问题，最多 3 项。

弹窗：

- `title`: `补齐需求`
- `question`: `要现在补充缺失信息吗？`
- 选项：`现在补充`（在聊天中输入补充内容）、`暂缓`（保留草稿等待后续）、`放弃`（停止当前需求）

媒介输入补充内容后，合并原始消息并重新调用 `validate_requirement`。

### 2. `confirm-structured-brief` — 结构化 brief 确认

触发：`validate_requirement.success=true, status=ready`。

正文展示平台、数量、预算、截止提交、内容要求、数据指标和影响表单字段。若数据指标会影响 MCN 回填字段，正文提醒一次。

弹窗：

- `title`: `确认需求`
- `question`: `系统理解是否可以进入筛选？`
- 选项：`确认筛选`（调用 `search_creators`）、`修改需求`（输入修改后重新校验）、`取消`（停止）

### 3. `confirm-filter-metrics` — 筛选口径确认

触发：`search_creators.success=true`，获得候选池结果。

正文展示各平台候选数量、粉丝范围、报价区间等关键筛选指标。若供给不足，合并 `insufficient-supply` 模式先处理。

弹窗：

- `title`: `确认筛选`
- `question`: `筛选口径是否满足需求？`
- 选项：`确认筛选`（调用 `rank_mcns`）、`调整口径`（输入调整后重新搜索）、`取消`（停止）

### 4. `confirm-supply-ratio` — MCN/野生比例确认

触发：`rank_mcns.success=true`，获得 `inquiry_advice`。

正文展示刊例硬筛候选数、硬筛后合格 MCN 数、建议 MCN/野生比例。硬筛后合格 MCN 少于 5 家时，`minimum_mcn_count=5` 自动失效；不得为了凑满 5 家放宽硬筛条件。若 60 位达人都属于同一家 MCN，先预警媒介是否启动 `manual_source_creators` 手扒。

弹窗：

- `title`: `确认比例`
- `question`: `按建议比例继续吗？`
- 选项：`按建议`（进入名单确认）、`调整比例`（媒介输入比例）、`全手扒`（调用或准备 `manual_source_creators`）

### 5. `mcn-select-for-wechat` — MCN 名单确认

正文展示编号 MCN 列表，包含 MCN、平台、返点、匹配度、达人数量和一句话理由。列表过长时先展示重点候选，并说明可让媒介补充编号。

弹窗：

- `title`: `确认机构`
- `question`: `按当前选择发送询价吗？`
- 选项：`确认机构`（进入表单字段确认）、`重新选择`（媒介输入编号）、`取消`（停止）

### 6. `confirm-form-fields` — 表单字段确认

正文展示回填表单字段及来源，只保留业务字段名，不展示内部字段名。

弹窗：

- `title`: `确认表单`
- `question`: `回填字段是否满足需求？`
- 选项：`确认字段`（进入权限 gate）、`调整字段`（媒介输入增删项）、`取消`（停止）

### 7. `confirm-wecom-permission` — 企微角色权限 gate

正文提示当前角色是否为媒介/采购。非媒介/采购直接阻断，不展示继续选项。

弹窗：

- `title`: `确认权限`
- `question`: `当前角色可发送企微询价吗？`
- 选项：`确认可发`（进入消息确认）、`换人处理`（暂停）、`取消`（停止）

### 8. `mcn-wechat-send` — 企微消息确认

先调用 `create_with_distributions` 的 `preview_only: true` 获取消息预览；正文展示发送对象、截止时间、提醒时间、核心消息摘要和表单影响。

弹窗：

- `title`: `确认发送`
- `question`: `是否发送企微询价？`
- 选项：`确认发送`（不可逆，调用 `preview_only:false`）、`修改消息`（媒介输入修改）、`取消`（停止）

Agent 层确认后，插件 hook 只做参数、角色、状态和直连绕过校验，不再触发 OpenClaw `requireApproval`。

### 9. `proceed-to-ranking` — 进入精排

触发：`create_with_distributions.success=true`，企微询价已发送。

弹窗：

- `title`: `进入精排`
- `question`: `现在对候选池做达人精排吗？`
- 选项：`开始精排`（调用 `rank_creators`）、`等待回填`（进入等待态）、`取消`（停止）

### 10. `confirm-medium-risk` — 中风险确认

正文列出风险 MCN 和风险原因，最多展示对决策必要的信息。

弹窗：

- `title`: `风险确认`
- `question`: `是否接受中风险继续？`
- 选项：`接受风险`（传 `medium_risk_confirmed:true`）、`剔除风险`（调整后继续）、`取消`（停止）

### 11. `confirm-risky-submission` — 风险账号提报确认

正文列出 `need_confirm` 账号、风险原因和影响。

弹窗：

- `title`: `提报风险`
- `question`: `是否接受风险账号提报？`
- 选项：`接受提报`（传 `allow_need_confirm_with_risk:true`）、`移除账号`（调整名单）、`取消`（停止）

### 12. `status-recovery` — 状态查询

正文展示当前阶段、已确认事实、阻断点和可执行下一步。

弹窗：

- `title`: `继续流程`
- `question`: `下一步怎么处理？`
- 选项：`继续`（执行下一步）、`看详情`（展示更多上下文）、`暂缓`（等待后续）

### 13. `requirement-modify` — 用户修改需求

媒介提供新的需求信息时，先直接携带原始补充消息重新调用 `validate_requirement`。如果重新校验后要继续执行下游不可逆动作，再按对应确认模式弹窗。

### 14. `insufficient-supply` — 供给不足

正文展示哪个平台不足、缺口数量和当前约束。不要自动放宽筛选。

弹窗：

- `title`: `供给不足`
- `question`: `按哪种方式继续？`
- 选项：`手工补量`（调用 `manual_source_creators`）、`放宽筛选`（调用 `search_creators`）、`按现有继续`（进入排序）
