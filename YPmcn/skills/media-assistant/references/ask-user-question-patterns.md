# AskUserQuestion 交互模式

本文档是本插件所有 Agent 层用户交互的单一可信源。每次 Agent 需要暂停并等待用户决策时，必须通过原生 `AskUserQuestion` 工具发起结构化提问，不得使用自由文本对话替代。

## 核心原则

- **每次停顿 = 一次 AskUserQuestion**：所有交互暂停点统一使用结构化 AskUserQuestion。
- **先汇报再问**：调用前先给一句简短结论（当前阶段结果 + 需要用户决策什么）。
- **选项即行动**：每个 option 的 `label` 是用户可选的行动，`description` 是选择的后果与范围。
- **用户不回复 = 中断**：不得在未收到用户选择时自动推进流程。
- **确认后立即执行**：用户选择确认类选项后，立即调用对应业务工具，不二次询问。

## 与 OpenClaw requireApproval 的双层关系

这是两层独立、互补的确认机制。两者都必须通过，缺一不可。

| 层级 | 机制 | 用途 | 触发者 | 执行顺序 |
|---|---|---|---|---|
| **Agent 层** | `AskUserQuestion` | 业务决策：参数确认、阶段推进、风险接受、范围选择 | Agent 按 SKILL.md 主动调用 | 工具调用**前** |
| **Hook 层** | `requireApproval` | 安全网关：不可逆操作审批、参数校验、超时阻断 | 插件 `src/index.ts` 自动触发 | 工具调用**时** |

**典型流程**（以企微发送为例）：
1. Agent 调用 `AskUserQuestion` 展示 MCN 选择和企微消息 → 用户选「确认发送」
2. Agent 收到确认后立即调用 `create_with_distributions`
3. 插件 `before_tool_call` hook 自动弹出 `requireApproval` 二次确认
4. 用户「allow-once」→ 工具真正执行

Agent 层确认**不等于**系统放行。Agent 只负责业务决策传达；hook 层审批是不可跳过的安全机制。

---

## 交互点索引

| ID | 阶段 | 触发条件 | 决策内容 | 确认后动作 |
|---|---|---|---|---|
| `pre-validate-requirement` | requirement | 首次业务工具调用前 | 确认目标工具、必填字段、拟传值 | 调用 validate_requirement |
| `requirement-draft` | requirement | validate_requirement 返回 status=draft | 用户补填缺失字段 | 携带补充消息重新调用 |
| `mcn-wechat-send` | mcn_planning | rank_mcns 成功后 | 是否向选中 MCN 发送企微询价 | 调用 create_with_distributions |
| `proceed-to-ranking` | distribution | create_with_distributions 成功后 | 是否进入达人精排 | 调用 rank_creators |
| `confirm-medium-risk` | mcn_planning | rank_mcns 含中风险 MCN | 接受中风险继续 | 调用 rank_mcns（medium_risk_confirmed=true） |
| `confirm-risky-submission` | submission | create_submission_batch 含 need_confirm 账号 | 接受风险账号提报 | 调用 create_submission_batch（allow_need_confirm_with_risk=true） |
| `status-recovery` | 任意 | 用户询问"现在什么状态" | 展示当前阶段 + 下一步选项 | 按用户选择推进或等待 |
| `requirement-modify` | requirement | 用户实质修改 Brief | 确认是否重新校验需求 | 携带补充消息调用 validate_requirement |
| `insufficient-supply` | candidate_pool | search_creators 供给不足 | 是否手工补量或放宽筛选 | 调用 manual_source_creators 或放宽 search_creators |

**注意**: `validate_requirement` 返回 status=ready 时不暂停。`pre-validate-requirement` 的 AskUserQuestion 已覆盖推进确认；ready 后连续调用 `search_creators` → `rank_mcns`，中间不插入额外等待。

---

## 模式定义

### 1. `pre-validate-requirement` — 首次调用参数确认

**触发**：第一条业务工具调用前（SKILL.md 参数闸门，第 3 步）。

**Agent 前置发言**：
> 需求已收集。准备调用 `validate_requirement` 进行校验。

**AskUserQuestion**：

```
header: "确认参数"
question: |
  调用 validate_requirement 进行需求校验。
  必填：raw_messages（已就绪）
  可选：project_context（未提供）
  确认后立即调用。
options:
  - 确认  → 参数无误，立即校验
  - 修改  → 调整参数后再校验
  - 取消  → 暂不执行
```

**处理**：
- 「确认调用」→ 立即调 `validate_requirement`，不等待额外确认
- 「修改参数」→ 等待用户提供修改内容，重新确认后调用
- 「取消」→ 停止，不调用任何业务工具

**注意**：SKILL.md 第 23 行原文已明确的 Brief 业务信息只汇总，不重复追问。ID、版本、run_id、inquiry_id 只能来自此前 MCP 成功响应。

---

### 2. `requirement-draft` — 需求不完整，需要用户补充

**触发**：`validate_requirement.success=true, status=draft`。

**Agent 前置发言**：
> 需求已记录，但以下信息需要补充后才能继续。

**AskUserQuestion**：

```
header: "补充信息"
question: |
  需求已记录但信息不完整：
  • {缺失字段 1}
  • {缺失字段 2}
  最多列 3 项，超出合并为「等 N 项」。
options:
  - 补充  → 在下条消息中提供补充信息
  - 暂缓  → 保留草稿稍后处理
  - 放弃  → 不保留此草稿
```

**处理**：
- 「我去补充」→ 等待用户下一条消息，拿到补充信息后重新调 `validate_requirement`（携带原始 + 补充消息）
- 「暂不处理」→ 停止，保留会话上下文等待用户后续消息
- 「放弃」→ 停止，不保留未完成需求

---

### 3. `mcn-wechat-send` — MCN 排序完成，确认发送企微询价

**触发**：`rank_mcns.success=true`，获得 MCN 列表和分发建议。

**Agent 前置发言**：
> MCN 排序完成。平台比例：{如 小红书 100%}，选中 MCN：{MCN-A（返点 45%）}、{MCN-B（返点 40%）}。拟写企微消息：{项目名称}，{平台}，{数量}位达人，单账号{预算范围}，返点{百分比}+。
> 
> 确认后立即创建项目分发。

**AskUserQuestion**：

```
header: "确认发送"
question: |
  平台 {小红书}，{2} 个 MCN，{10} 位达人。
  确认后将调用 create_with_distributions 发送企微询价。
  ⚠️ 发送前系统会弹出安全审批，需点击「allow-once」才会真正发送。
options:
  - 确认发送  → 立即发送企微询价
  - 修改      → 调整 MCN 或消息内容
  - 取消      → 不发送
```

**处理**：
- 「确认发送」→ 立即调 `create_with_distributions`，传入 `mcn_run_id`、`deadline`、`remindAt`
- 「修改选择」→ 等待用户指定调整内容
- 「取消」→ 停止

**注意**：Agent 层确认后，插件 hook 会自动触发 `requireApproval` 二次确认。如果 requireApproval 的 gateway 不可用（报 "Plugin approval required (gateway unavailable)"），工具调用会被阻断。此时需要通知用户修复插件 gateway，不可绕过。

---

### 4. `proceed-to-ranking` — 企微发送成功，确认进入精排

**触发**：`create_with_distributions.success=true`，企微询价已发送。

**Agent 前置发言**：
> 企微询价已发送。deadline：{时间}。下一步是达人精排。

**AskUserQuestion**：

```
header: "开始精排"
question: |
  企微询价已发送，进入达人精排阶段。
  ⚠️ 系统会弹出安全审批，需点击「allow-once」。
options:
  - 确认精排  → 调用 rank_creators
  - 等待询价  → 先等 MCN 回复询价
  - 取消      → 不进入精排
```

**处理**：
- 「确认精排」→ 立即调 `rank_creators`
- 「等待询价」→ 进入等待态，收到用户新消息前不得执行下一步
- 「取消」→ 停止

---

### 5. `confirm-medium-risk` — 中风险确认

**触发**：rank_mcns 结果含中风险 MCN（或 workflow_state 返回 pending_gate=confirm_medium_risk）。

**Agent 前置发言**：
> MCN 排序结果中存在中风险项，需要你确认后才能继续。

**AskUserQuestion**：

```
header: "中风险"
question: |
  {MCN-A} — {风险原因}
  接受后将以 medium_risk_confirmed=true 继续。
options:
  - 接受  → 接受风险，继续排序
  - 拒绝  → 停止当前流程
```

**处理**：
- 「接受风险」→ 调 `rank_mcns`，设置 `medium_risk_confirmed: true`
- 「拒绝」→ 停止，不继续

---

### 6. `confirm-risky-submission` — 风险账号提报确认

**触发**：create_submission_batch 包含 `need_confirm` 标记的达人账号。

**Agent 前置发言**：
> 提报批次中存在需要确认的风险账号，需要你确认后才能提报。

**AskUserQuestion**：

```
header: "风险账号"
question: |
  {达人名称} 被标记为 need_confirm — {风险说明}
  接受后将以 allow_need_confirm_with_risk=true 提报。
options:
  - 接受    → 接受风险，继续提报
  - 移除    → 移除该账号后提报
  - 拒绝    → 停止提报
```

**处理**：
- 「接受并提报」→ 调 `create_submission_batch`，设置 `allow_need_confirm_with_risk: true`
- 「移除风险账号」→ 调整提报列表后重新确认
- 「拒绝」→ 停止

---

### 7. `status-recovery` — 状态查询回复

**触发**：用户询问"现在什么状态"、"卡在哪里"、"下一步是什么"等。

**Agent 前置发言**：
> 当前进度如下。

**AskUserQuestion**：

```
header: "当前状态"
question: |
  阶段：{requirement}，已完成 {校验通过}。
  下一步：搜索候选达人。{如有阻断，说明原因}
options:
  - 继续      → 执行下一步
  - 查看详情  → 展示更多上下文
  - 知道了    → 不执行，等待后续指令
```

**处理**：
- 「继续」→ 执行当前阶段的下一个业务动作
- 「查看详情」→ 按 frontend-response.md 展示更多证据
- 「我知道了」→ 不操作，等待用户后续指令

---

### 8. `requirement-modify` — 用户修改需求

**触发**：用户在任何阶段提供新的需求信息或修改原需求。

**Agent 前置发言**：
> 收到需求修改，需要重新校验。

**AskUserQuestion**：

```
header: "需求变更"
question: |
  收到新的需求信息：{变更摘要}
  需重新调用 validate_requirement 校验。
options:
  - 确认  → 携带新信息重新校验
  - 暂缓  → 保留消息，稍后处理
```

**处理**：
- 「确认更新」→ 携带原始 + 补充消息重新调 `validate_requirement`；旧 ID/版本只使用 MCP 已返回的真实值
- 「暂不处理」→ 停止

---

### 9. `insufficient-supply` — 供给不足

**触发**：`search_creators` 返回候选池供给不足。

**Agent 前置发言**：
> 候选池搜索完成。{小红书 8 位}，{抖音 3 位，不足 — 缺 2 位}。可选：手工补量、放宽筛选或按现有结果继续。

**AskUserQuestion**：

```
header: "供给不足"
question: |
  抖音仅 3 位达人，缺 2 位。可选方案：
  - 手工补量：手动指定达人
  - 放宽筛选：放宽粉丝量/预算约束
  - 继续：接受现有候选池进入 MCN 排序
options:
  - 手工补量  → 调用 manual_source_creators
  - 放宽筛选  → 放宽约束后重新搜索
  - 继续      → 按当前候选池继续
  - 取消      → 停止
```

**处理**：
- 「手工补量」→ 调 `manual_source_creators`
- 「放宽筛选」→ 调 `search_creators` 并传入 `authorized_relaxations`
- 「继续」→ 调 `rank_mcns`，不补量
- 「取消」→ 停止

---

## Agent 实现规范

### AskUserQuestion 调用格式

所有模式中的 schema 描述是语义定义。实际调用时使用 OpenClaw/Codex 的原生 `question` 工具：

```typescript
question({
  questions: [{
    header: "确认调用参数",          // 短标题，≤30 字符
    question: "目标工具：validate_requirement\n...",  // 完整问题，支持多行
    options: [
      { label: "确认调用", description: "参数无误，立即调用 validate_requirement 进行需求校验" },
      { label: "修改参数", description: "需要调整 raw_messages 内容或补充 project_context" },
      { label: "取消", description: "暂不执行，返回等待新指令" }
    ]
  }]
})
```

### 单选与多选的使用判断

默认所有交互点为单选（`multiple: false`）。仅在以下条件**全部满足**时使用多选（`multiple: true`）：

1. **选项是并列对象**：用户需要从一组独立对象中挑选子集，每个对象互不排斥。例如「选择需要发送的 MCN」、「选择接受风险的项目」。
2. **选项 ≥ 3 个**：2 个选项时多选无意义，用户直接挑一个。
3. **结果可部分执行**：选 A 不选 B 不会导致流程断裂，每个子集都有明确的下一步动作。

**反面标准**：选项是互斥的「执行路径」（如「确认/修改/取消」、「继续/等待/停止」），必须用单选。

**多选调用格式**：

```typescript
question({
  questions: [{
    header: "选择 MCN",               // ≤30 字符
    multiple: true,                    // 多选模式
    question: "请选择需要发送企微询价的 MCN：\n• 未选中的 MCN 将在本轮跳过",
    options: [
      { label: "MCN-A", description: "小红书，返点 45%，匹配度 0.92" },
      { label: "MCN-B", description: "抖音+小红书，返点 40%，匹配度 0.88" },
      { label: "MCN-C", description: "抖音，返点 42%，匹配度 0.85" },
    ]
  }]
})
```

多选返回值是 `label` 数组（如 `["MCN-A", "MCN-C"]`），按数组顺序依次处理。

**多选注意事项**：

1. **不设默认全选**：选项默认全部未选中，用户必须主动勾选。不要把第一个 option 标记为推荐。
2. **说明跳过的后果**：未选中的选项会怎样（跳过、移除、拒绝），必须在 `question` 文本中说明。
3. **空选处理**：用户可能不选任何选项直接确认。需在 `description` 中说明「不选即视为全不选/全跳过」。
4. **上限 6 个选项**：多选最多 6 个选项，超出合并分组。
5. **确认后一次执行**：用户选择后立即按选中项批量执行，不在每项间插入额外确认。

### 通用规范

1. **选项数量**：单选 2-4 个选项，多选 2-6 个选项。超出上限时合并次要选项。
2. **默认推荐**：第一个 option 为推荐操作。
3. **不可逆操作**：涉及发送询价、创建项目、提报等不可逆操作时，`description` 中明确说明不可逆性。
4. **失败不继续**：用户选择取消/拒绝后，Agent 必须停止，不得自动选择备选方案推进。
5. **不要在 AskUserQuestion 中泄露内部信息**：不展示 trace_id、JSON 结构、内部状态字段、数据库 ID。面向用户只用业务中文。
6. **requireApproval 失败处理**：如果 Agent 层确认通过但 hook 层 requireApproval 返回 "gateway unavailable"，Agent 应报告用户「插件审批网关不可用，需要修复后重试」，不得绕过或尝试替代路径。

### 字数限制

AskUserQuestion 弹窗空间有限，过长会占满屏幕导致用户看不到选项。各字段硬限制：

| 字段 | 上限 | 说明 |
|---|---|---|
| `header` | 10 字 | 一行标题，只说「确认什么」。如「确认发送」「风险确认」 |
| `question` | 4 行 | 每行 ≤30 字。只放决策必需信息，不堆砌业务报告 |
| `label` | 6 字 | 动词短语。如「确认发送」「移除并继续」 |
| `description` | 20 字 | 一句话说明选中后的后果 |

**压缩策略**：

- `question` 不是前端回复板。业务详情（匹配度、返点、理由）放到前置发言中，question 只写决策摘要。
- 多个同类对象（MCN、账号）最多列 3 个，超出写「等 N 个」。
- label 省略主语和宾语，用户能通过上下文推断。如不说「接受该 MCN 的风险」→ 说「接受」
