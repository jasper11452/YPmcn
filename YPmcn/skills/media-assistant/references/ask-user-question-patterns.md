# 用户交互模式

本文档是本插件所有 Agent 层用户交互的单一可信源。每次 Agent 需要暂停并等待用户决策时，必须**直接输出文本表格**供用户阅读，用户在聊天中打字回复选择，不得使用 `question()` 工具发起结构化提问。

## 核心原则

- **文本表格输出，用户打字回复**：Agent 将选项以文本表格形式直接输出到聊天中，用户通过打字回复编号或标签来做出选择。
- **需要用户输入时，合并到同一轮**：如果下一步需要用户打字（如补充需求、修改内容、指定数值），直接在同一个表格或提示中引导用户回复。
- **每次停顿 = 一次文本表格输出**：所有交互暂停点统一使用文本表格格式。
- **先汇报再问**：输出表格前先给一句简短结论（当前阶段结果 + 需要用户决策什么）。
- **选项即行动**：每个选项是用户可选的行动，附带说明选择的后果与范围。
- **用户不回复 = 中断**：不得在未收到用户选择时自动推进流程。
- **确认后立即执行**：用户回复确认类选项后，立即调用对应业务工具，不二次询问。

---

## 何时暂停 / 不暂停

### ✅ 需要暂停（需要用户决策）

| 场景 | 示例 | 交互方式 |
|---|---|---|
| 确认后执行不可逆操作 | 发送企微询价、创建提报批次 | 输出选项表格，用户打字回复 |
| 二选一的分支路径 | 接受/拒绝风险、继续/等待 | 输出选项表格 |
| 多路径选择（互斥） | 供给不足时的应对方案 | 输出选项表格 |
| 需要用户知晓并确认的事实 | 参数确认、风险披露 | 输出选项表格 |
| 从列表中选择对象 | 选择需要发送询价的 MCN | 输出编号列表表格，用户打字回复编号 |

### ❌ 不需要暂停

| 场景 | 原因 |
|---|---|
| 纯信息展示（无决策） | 直接输出结果，不等待 |

---

## 展示格式规范

### 文本表格格式

所有选项以 Markdown 表格形式输出：

```markdown
| 选项 | 说明 |
|------|------|
| **1. 确认发送** | 创建分发并发送企微询价（不可逆） |
| **2. 修改消息** | 在聊天中说明修改内容，重新生成 |
| **3. 取消** | 不发送，可调整后重来 |
```

### 编号列表格式（用于选择对象，如 MCN 列表）

当用户需要从一组对象中选择子集时，使用编号列表 + 表格：

```markdown
以下 MCN 候选，请回复编号选择需要发送询价的机构（多选用逗号分隔，如 `1,3,5`；全选回复 `全部`）：

| # | MCN | 平台 | 返点 | 匹配度 |
|---|-----|------|------|--------|
| 1 | MCN-A | 小红书 | 45% | 0.92 |
| 2 | MCN-B | 抖音 | 40% | 0.88 |
| 3 | MCN-C | 双平台 | 42% | 0.85 |
| 4 | MCN-D | 小红书 | 38% | 0.80 |
| 5 | MCN-E | 抖音 | 35% | 0.75 |

回复 `全部` 选中所有，回复 `跳过` 本轮不发送询价。
```

### 信息充分性

- 业务详情（匹配度、返点、理由）直接在表格中展示
- 多个同类对象（MCN、账号）全部列出，不做截断
- 前置发言只给一句结论，不做详细展开

### 通用规范

1. **选项数量不限**：不再有 AskUserQuestion 的 4 选项限制，列表可以包含任意数量的选项
2. **不可逆操作**：涉及发送询价、创建项目、提报等不可逆操作时，在表格说明中标注「不可逆」
3. **失败不继续**：用户选择取消/拒绝后，Agent 必须停止，不得自动选择备选方案推进
4. **不泄露内部信息**：不展示 trace_id、JSON 结构、内部状态字段、数据库 ID。面向用户只用业务中文
5. **Hook 阻断处理**：如果 Agent 层确认通过但 hook 阻断调用，Agent 应报告具体阻断原因并停止，不得绕过或尝试替代路径

---

## 与 Hook 校验的关系

文本确认负责业务决策；hook 负责系统边界。当前插件不再为 `create_with_distributions` 或 `rank_creators` 触发 OpenClaw `requireApproval`。

| 层级 | 机制 | 用途 | 触发者 | 执行顺序 |
|---|---|---|---|---|
| **Agent 层** | 文本表格 + 用户打字回复 | 业务决策：参数确认、阶段推进、风险接受、范围选择 | Agent 按 SKILL.md 主动输出 | 工具调用**前** |
| **Hook 层** | `before_tool_call` / `after_tool_call` | 校验参数、角色、状态、直连绕过和等待锁 | 插件 `src/index.ts` 自动触发 | 工具调用**时/后** |

**典型流程**（以企微发送为例）：
1. Agent 输出 MCN 列表表格和企微消息预览 → 用户打字回复「1,3」选择 MCN，再回复「确认发送」
2. Agent 收到确认后立即调用 `create_with_distributions`
3. 插件 `before_tool_call` hook 校验 `deadline/remindAt`、`usageScope: "project"`、角色、gate 和直连绕过；通过后工具执行
4. 插件 `after_tool_call` 在成功后进入等待锁，收到用户新消息前不推进下一步

Agent 层确认**不等于**系统放行。Agent 只负责业务决策传达；hook 层校验是不可跳过的安全机制。

---

## 交互点索引

| ID | 阶段 | 触发条件 | 决策内容 | 确认后动作 |
|---|---|---|---|---|
| `pre-validate-requirement` | requirement | 首次业务工具调用前 | 展示参数，询问是否有补充（文本表格） | 用户确认后调用 validate_requirement |
| `requirement-draft` | requirement | validate_requirement 返回 status=draft | 用户补填缺失字段 | 携带补充消息重新调用 |
| `confirm-structured-brief` | requirement | validate_requirement 返回 status=ready | 确认平台、数量、deadline、预算/内容、数据指标和表单字段影响 | 用户确认后调用 search_creators |
| `confirm-supply-ratio` | mcn_planning | rank_mcns 成功后 | 确认 MCN 与野生比例、是否需要手扒 | 进入 MCN 名单确认 |
| `mcn-select-for-wechat` | mcn_planning | 比例确认后 | 选择需要发送询价的 MCN（编号选择） | 进入表单字段确认 |
| `confirm-form-fields` | mcn_planning | MCN 名单确认后 | 确认回填表单字段能否覆盖 brief 要求、增减字段 | 进入企微权限 gate |
| `confirm-wecom-permission` | distribution | 表单字段确认后 | 企微角色权限 gate（仅媒介/采购） | 进入消息内容确认 |
| `mcn-wechat-send` | distribution | 权限 gate 通过后 | 确认企微消息文本内容和发送对象 | 调用 create_with_distributions |
| `proceed-to-ranking` | distribution | create_with_distributions 成功后 | 是否进入达人精排 | 调用 rank_creators |
| `confirm-medium-risk` | mcn_planning | rank_mcns 含中风险 MCN | 接受中风险继续 | 调用 rank_mcns（medium_risk_confirmed=true） |
| `confirm-risky-submission` | submission | create_submission_batch 含 need_confirm 账号 | 接受风险账号提报 | 调用 create_submission_batch（allow_need_confirm_with_risk=true） |
| `status-recovery` | 任意 | 用户询问"现在什么状态" | 展示当前阶段 + 下一步选项 | 按用户选择推进或等待 |
| `requirement-modify` | requirement | 用户实质修改 Brief | 确认是否重新校验需求 | 携带补充消息调用 validate_requirement |
| `insufficient-supply` | candidate_pool | search_creators 供给不足 | 是否手工补量或放宽筛选 | 调用 manual_source_creators 或放宽 search_creators |

**注意**: `validate_requirement` 返回 status=ready 后必须停在结构化 brief 确认，不再自动连续调用 `search_creators`；`rank_mcns` 后必须依次完成比例、机构名单、表单字段和企微权限四步确认。

---

## 模式定义

### 1. `pre-validate-requirement` — 首次调用参数确认

**触发**：第一条业务工具调用前（SKILL.md 参数闸门，第 3 步）。

**Agent 前置发言**：
> 需求已收集。准备调用 `validate_requirement` 进行校验。
>
> 目标工具：validate_requirement
> 必填：raw_messages（已就绪）
> 可选：project_context（未提供）
>
> 以上是否有需要补充的内容？如无需补充直接回复「确认」即可。

**处理**：
- 用户回复「确认」「没问题」「继续」等 → 立即调 `validate_requirement`
- 用户回复补充内容 → Agent 将补充信息合并后调 `validate_requirement`

**注意**：用户可能需要打字补充内容，所以直接引导用户在聊天中回复。SKILL.md 原文已明确的 Brief 业务信息只汇总，不重复追问。ID、版本、run_id、inquiry_id 只能来自此前 MCP 成功响应。

---

### 2. `requirement-draft` — 需求不完整，需要用户补充

**触发**：`validate_requirement.success=true, status=draft`。

**Agent 前置发言**：
> 需求已记录，但以下信息需要补充后才能继续。

**文本输出**：

```markdown
缺少以下信息：
• {缺失字段 1}
• {缺失字段 2}

| 选项 | 说明 |
|------|------|
| **直接回复补充内容** | 输入缺失信息，Agent 合并后重新校验 |
| **暂缓** | 保留草稿，稍后补充 |
| **放弃** | 删除草稿，不保留 |
```

**处理**：
- 用户**直接打字回复**缺失信息 → Agent 将补充内容与原始消息合并，重新调 `validate_requirement`
- 用户回复「暂缓」→ 停止，保留会话上下文等待用户后续消息
- 用户回复「放弃」→ 停止，不保留未完成需求

---

### 2.5. `confirm-structured-brief` — 结构化 brief 确认

**触发**：`validate_requirement.success=true, status=ready`。

**Agent 前置发言**：
> 需求解析完成。以下是系统理解的需求结构，请确认。

**文本输出**：

```markdown
结构化需求确认：

| 字段 | 解析结果 |
|------|----------|
| 平台 | {platforms} |
| 数量 | {quantity} 位达人 |
| 预算 | {budget_range} 元/篇 |
| 截止提交 | {deadline} |
| 内容要求 | {content_summary} |
| 数据指标 | CPM≤{cpm} / CPE≤{cpe} / CTR≥{ctr} |
| 影响表单字段 | CPM / CPE / CTR / 报价 / 返点 / 档期 |

> ⚠️ 以上数据指标将影响后续 MCN 回填表单字段。如有其他数据要求，请现在补充。

| 选项 | 说明 |
|------|------|
| **确认** | 确认需求理解无误，进入筛选 |
| **补充数据指标** | 需要添加 CPM/CPC/CPE/CTR 等字段要求 |
| **修改** | 修改解析结果，重新校验 |
| **取消** | 停止，不继续 |
```

**处理**：
- 用户回复「确认」→ 调 `search_creators`
- 用户回复补充或修改内容 → 合并消息后重新调 `validate_requirement`

---

### 2.6. `confirm-supply-ratio` — MCN/野生比例确认

**触发**：`rank_mcns.success=true`，获得 `inquiry_advice`。

**Agent 前置发言**：
> MCN 排序完成。系统判定库存量：{sufficient/insufficient}。建议 MCN 和野生比例：{ratio}。

**文本输出**：

```markdown
当前供给评估：
• 刊例硬筛候选：{rate_card_count} 位
• 建议 MCN 来源：{mcn_ratio}%
• 建议野生/手扒：{wild_ratio}%

| 选项 | 说明 |
|------|------|
| **接受建议比例** | 按建议比例分配，进入 MCN 名单确认 |
| **调整比例** | 手动调整 MCN/野生比例（如 70/30） |
| **全 MCN** | 全部走 MCN 询价 |
| **全野生/手扒** | 全部手扒补量 |
```

**处理**：
- 用户回复比例选择 → 进入 MCN 机构名单确认
- 比例确认前不得发送企微或进入名单确认

---

**触发**：`rank_mcns.success=true`，获得 `mcn_recommendation_items`。

**Agent 前置发言**：
> MCN 排序完成。共 {N} 个候选机构，平台比例：{如 小红书 100%}。

**文本输出**：

```markdown
以下 MCN 候选，请回复编号选择需要发送询价的机构（多选用逗号分隔，如 `1,3`）：

| # | MCN | 平台 | 返点 | 匹配度 | 达人数量 | 备注 |
|---|-----|------|------|--------|----------|------|
| 1 | {MCN-A} | 小红书 | 45% | 0.92 | 15 | |
| 2 | {MCN-B} | 双平台 | 42% | 0.85 | 12 | |
| 3 | {MCN-C} | 抖音 | 40% | 0.88 | 10 | |
| ... | ... | ... | ... | ... | ... | ... |

回复 `全部` 选中所有，回复 `跳过` 本轮不发送询价。
```

**处理**：
- 用户回复编号（如 `1,3`）→ 选中对应 MCN，进入 `mcn-wechat-send` 展示消息内容
- 用户回复「全部」→ 选中所有 MCN，进入消息确认
- 用户回复「跳过」→ 视为取消，停止流程

**注意**：列表不再受 AskUserQuestion 的 6 选项上限约束，可以展示完整 MCN 列表。

---

### 4. `confirm-form-fields` — 表单字段确认

**触发**：MCN 名单已确认，准备发送企微询价前。

**Agent 前置发言**：
> 以下是根据 brief 生成的回填表单字段，请确认是否需要增减。

**文本输出**：

```markdown
回填表单字段：

| 字段 | 来源 | 是否必填 |
|------|------|----------|
| 达人账号 | 系统 | 是 |
| 报价（含税/不含税）| brief | 是 |
| 返点 | brief | 是 |
| CPM | brief 数据要求 | 是 |
| CPE | brief 数据要求 | 是 |
| CTR | brief 数据要求 | 是 |
| 阅读量 | 系统可选 | 否 |
| 互动率 | 系统可选 | 否 |
| 档期 | 系统 | 是 |
| 是否可开票 | brief | 是 |

| 选项 | 说明 |
|------|------|
| **确认** | 表单字段无误，进入企微权限 gate |
| **增加字段** | 添加数据指标或其他回填项 |
| **删除字段** | 移除不需要的字段 |
```

**处理**：
- 用户确认后 → 进入企微角色权限 gate
- 表单字段未确认前不得调用 `create_with_distributions`

---

### 4.5. `confirm-wecom-permission` — 企微角色权限 gate

**触发**：所有前置确认完成，准备发送企微询价。

**Agent 前置发言**：
> 企微发送权限检查：当前角色为 {media/procurement/other}。

**只允许媒介和采购角色继续**。account、策划、com 等角色调用企微发送将被直接阻断，不会到达此确认。

---

### 5. `mcn-wechat-send` — 确认企微消息内容

**触发**：用户在 `mcn-select-for-wechat` 中选中 MCN 后。

**Agent 前置发言**：
> 已选中 {N} 个 MCN。以下是拟发送的企微消息：

**然后调用 `create_with_distributions` 的 `preview_only: true` 获取消息预览**，展示消息全文。

> 消息内容：
> 【悦普供应商提报通知】
> 项目名称：{project_name}
> 平台：{platforms}
> 数量：{quantity} 位达人
> 预算：{budget_range}
> 返点：{rebate}+
> 截止提交：{deadline}
> 填写链接：{form_link}

**文本输出**：

```markdown
| 选项 | 说明 |
|------|------|
| **确认发送** | 调用 create_with_distributions 发送（不可逆） |
| **修改消息** | 在聊天中说明修改内容，重新生成 |
| **取消** | 不发送，可调整后重来 |
```

**处理**：
- 用户回复「确认发送」→ 立即调 `create_with_distributions`（`preview_only: false`），传入 `supplierIds`、`notification_template`，并固定 `usageScope: "project"`
- 用户回复「修改消息」→ 停止。用户在聊天中说明修改内容，Agent 收到后重新展示消息确认
- 用户回复「取消」→ 停止

**注意**：Agent 层确认后，插件 hook 只做参数、角色、状态和直连绕过校验，不再触发 OpenClaw `requireApproval`。

---

### 5. `proceed-to-ranking` — 企微发送成功，确认进入精排

**触发**：`create_with_distributions.success=true`，企微询价已发送。

**Agent 前置发言**：
> 企微询价已发送。deadline：{时间}。下一步是达人精排。

**文本输出**：

```markdown
| 选项 | 说明 |
|------|------|
| **确认精排** | 调用 rank_creators 排序 |
| **等待询价** | 先等 MCN 回复报价 |
| **取消** | 不进入精排 |
```

**处理**：
- 用户回复「确认精排」→ 立即调 `rank_creators`
- 用户回复「等待询价」→ 进入等待态，收到用户新消息前不得执行下一步
- 用户回复「取消」→ 停止

---

### 6. `confirm-medium-risk` — 中风险确认

**触发**：rank_mcns 结果含中风险 MCN（或 workflow_state 返回 pending_gate=confirm_medium_risk）。

**Agent 前置发言**：
> MCN 排序结果中存在中风险项，需要你确认后才能继续。

**文本输出**：

```markdown
**中风险 MCN**：{MCN-A} — {风险原因}

| 选项 | 说明 |
|------|------|
| **接受** | 接受风险，以 medium_risk=true 继续排序 |
| **拒绝** | 停止当前流程 |
```

**处理**：
- 用户回复「接受」→ 调 `rank_mcns`，设置 `medium_risk_confirmed: true`
- 用户回复「拒绝」→ 停止，不继续

---

### 7. `confirm-risky-submission` — 风险账号提报确认

**触发**：create_submission_batch 包含 `need_confirm` 标记的达人账号。

**Agent 前置发言**：
> 提报批次中存在需要确认的风险账号，需要你确认后才能提报。

**文本输出**：

```markdown
**风险账号**：{达人名称}，标记为 need_confirm
风险：{风险说明}

| 选项 | 说明 |
|------|------|
| **接受** | 接受风险，继续提报 |
| **移除** | 移除该账号后提报 |
| **拒绝** | 停止提报 |
```

**处理**：
- 用户回复「接受」→ 调 `create_submission_batch`，设置 `allow_need_confirm_with_risk: true`
- 用户回复「移除」→ 调整提报列表后重新确认
- 用户回复「拒绝」→ 停止

---

### 8. `status-recovery` — 状态查询回复

**触发**：用户询问"现在什么状态"、"卡在哪里"、"下一步是什么"等。

**Agent 前置发言**：
> 当前进度如下。

**文本输出**：

```markdown
阶段：{requirement}，已完成 {校验通过}
下一步：搜索候选达人
{如有阻断，说明原因}

| 选项 | 说明 |
|------|------|
| **继续** | 执行下一步 |
| **查看详情** | 展示更多上下文 |
| **知道了** | 不执行，等待后续指令 |
```

**处理**：
- 用户回复「继续」→ 执行当前阶段的下一个业务动作
- 用户回复「查看详情」→ 按 frontend-response.md 展示更多证据
- 用户回复「知道了」→ 不操作，等待用户后续指令

---

### 9. `requirement-modify` — 用户修改需求

**触发**：用户在任何阶段提供新的需求信息或修改原需求。

**Agent 前置发言**：
> 收到需求修改，需要重新校验。

**文本输出**：

```markdown
收到新的需求信息：{变更摘要}
需重新调用 validate_requirement 校验。

| 选项 | 说明 |
|------|------|
| **确认** | 携带新信息重新校验 |
| **暂缓** | 保留消息，稍后处理 |
```

**处理**：
- 用户回复「确认」→ 携带原始 + 补充消息重新调 `validate_requirement`；旧 ID/版本只使用 MCP 已返回的真实值
- 用户回复「暂缓」→ 停止

---

### 10. `insufficient-supply` — 供给不足

**触发**：`search_creators` 返回候选池供给不足。

**Agent 前置发言**：
> 候选池搜索完成。{小红书 8 位}，{抖音 3 位，不足 — 缺 2 位}。可选：手工补量、放宽筛选或按现有结果继续。

**文本输出**：

```markdown
抖音仅 3 位达人，缺 2 位。

| 选项 | 说明 |
|------|------|
| **手工补量** | 调用 manual_source_creators 手动补充 |
| **放宽筛选** | 放宽约束后重新搜索 |
| **继续** | 按当前候选池继续排序 |
| **取消** | 停止，不进入 MCN 排序 |
```

**处理**：
- 用户回复「手工补量」→ 调 `manual_source_creators`
- 用户回复「放宽筛选」→ 调 `search_creators` 并传入 `authorized_relaxations`
- 用户回复「继续」→ 调 `rank_mcns`，不补量
- 用户回复「取消」→ 停止
