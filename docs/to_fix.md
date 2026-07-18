# 实机测试待修问题

> 测试日期：2026-07-18  
> 环境：OpenClaw + YPmcn 3.0.8  
> 说明：本文件只保留尚未修复或仅部分修复的问题；已经完成并有源码、测试或实机证据的问题已删除。

## 当前阻塞项

1. `search_creators` 仍出现 `vector_config_missing`，价格放宽到 `[0,99999999]` 后仍匹配不到达人。
2. 搜索响应、恢复状态和 Hook 判断不一致，风险、门禁和状态版本没有形成权威闭环。
3. OpenClaw 暴露 resources/prompts，但插件正式契约只允许 15 个业务 Tool。
4. Provider 写入前没有校验业务 ID 是否真实存在、互相关联，也没有完整的服务端幂等与对账保护。

Skill 和 Hook 已提供 fail-closed 止血措施，但不能代替 MCP、Provider 和数据库侧修复。

---

## 一、Skill 与测试环境

| 问题 | 状态 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| Gateway 协议不匹配 | 暂不修 | `GatewayClientRequestError: protocol mismatch`；用户 PATH 中 OpenClaw 为 `2026.6.6`，18789 端口 Gateway 使用不同协议版本 | 用户手工环境仍可能无法通过 Gateway 模式运行 | OpenClaw 只用于测试时使用可工作的隔离 CLI/模式；正式使用前统一 CLI 与 Gateway 版本 |
| 默认模型鉴权失败 | 未修复，测试已绕过 | `HTTP 401 invalid_api_key`；原模型 `openai/gpt-5.5` | 默认 OpenAI 凭证仍失效 | 测试暂用 `deepseek/deepseek-v4-flash`；正式环境更新凭证或默认模型配置 |
| 插件信任来源不明确 | 暂不修 | 手工环境曾报告 `plugins.allow is empty`、`loaded without install/load-path provenance` | 用户手工安装环境没有统一的 allowlist 和可审计安装来源 | 正式部署时补 `plugins.allow` 并统一安装来源；仓库自动 smoke 的隔离安全基线不能替代手工环境配置 |
| 标准 Brief 确认前调用宿主/非契约工具 | 待修 | 三次独立解析中有一次先调用宿主 `read`，随后调用 `prompts_get(name="AskUserQuestion")` 并被 Hook 返回 `INTEGRATION_REQUIRED` | injected fast path 没有稳定阻止 Agent 读取 Skill 或把宿主原生 AskUserQuestion 误当成 MCP prompt capability，未满足确认前零 Tool 调用 | 标准 Brief 直接使用 injected fast path；禁止读取 Skill、调用 resources/prompts 或其他 Tool；需要弹窗时只用宿主原生 AskUserQuestion |
| “母婴/亲子” taxonomy 解析预览不稳定 | 部分修复 | 实机预览仍可能把“账号类型：母婴类、亲子相关”直接映射到 `talentTypeLabel`；实际提交会被 `BLOCKED_TAXONOMY_CONFIRMATION_REQUIRED` 阻断 | Hook 能阻止错误 payload 进入 Provider，但 Tool 调用前的模型文本预览仍可能漂移 | 引入确定性结构化解析器/渲染器，并由正式 taxonomy 契约提供合法值和唯一映射 |
| 解析原子明细与汇总计数不稳定 | 部分修复 | 正式提交的 audit 冲突会被 `BLOCKED_REQUIREMENT_AUDIT_CONFLICT` 阻断；实机文本预览仍曾出现明细与汇总合计不等、组合 `targetField` 和漏计歧义 | Hook 只能校验即将提交的 `rawMessagesJson`，不能保证调用前的自由文本预览确定化 | 让明细、gate 和 summary 由同一确定性 atom 列表生成，不再依赖模型独立计数 |

### 当前边界

- 最新包三次全新会话解析稳定性测试为 **0/3 满足完整验收**：一次擅自调用 `read/prompts_get`；一次遗漏 payload/audit/coverage 并错误映射 taxonomy；一次识别歧义但未输出正式 `rawMessagesJson`，日期也未补齐 schema 要求的秒。
- 三轮均未产生 YPmcn 业务写入；taxonomy、schema 和 audit 的提交门禁已 fail closed，但不能据此把调用前文本预览视为可靠结构化结果。
- JSON taxonomy 字段的合法值集合仍需由 Provider/数据契约提供，不能由 Skill 猜测。
- 仓库自动测试已隔离 OpenClaw 状态和配置；用户手工运行不同版本 OpenClaw 时仍应使用 `--profile` 或显式设置 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`。

---

## 二、Hooks 与能力契约

| 问题 | 状态 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| 手工 OpenClaw 环境安全审计未通过 | 手工环境待处理 | 历史 deep audit：`critical=1, warn=5, info=1`；仓库隔离 smoke 已达到 `summary.critical=0` | 自动测试安全基线不会修改用户全局认证、trusted proxies、插件来源和工具策略 | 在目标手工/正式环境单独配置并复跑 deep audit |
| Capability 与正式 allowlist 不一致 | 待修 | `resources_list`、`prompts_list`、`prompts_get` 返回 `INTEGRATION_REQUIRED: Tool ... is not declared by the target contract` | MCP initialize 暴露的 capability、宿主 wrapper、`spec/mcp.json` 和 Hook allowlist 不是同一契约来源 | 不支持时停止注册对应 capability/wrapper；支持时增加独立 capability 契约和测试 |

### Hook 不能替代的 Provider 校验

- 本地 TTL provenance ledger 已覆盖 `kwUid/requirement_id/project_id/mcn_id/inquiry_id/run_id`，用于阻止来源不明的调用。
- ledger 按插件根目录和 TTL 隔离，不是数据库约束，也不能证明实体存在、归属正确或彼此关联。
- Provider 仍必须在每个业务写入前执行存在性、所有权/关联关系和幂等校验。

---

## 三、MCP 工具

| 问题 | 状态 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| `search_creators` 供给方案字段不全 | 部分修复 | Skill/Hook 已要求并校验完整供给方案；生产响应曾缺少 `target_submission_count`、`estimated_valid_return_count`、`estimated_gap_count`、`recommended_mcn_count`、`mcn_covered_creator_count` | 消费端可以 fail closed，但不能让 Provider 返回缺失字段；`search_creators` 正式输出仍是开放对象 | Provider 返回全部十个供给字段，并在 `spec/mcp.json` 中建立可验证的正式输出 schema |
| resources 契约不一致 | 待修 | Probe 显示 `resources: true`，调用 `resources_list` 却不在正式契约中 | 宿主宣告可用，插件又拒绝调用 | 不支持就停止暴露；支持就补 resources capability 契约、wrapper 和测试 |
| 字段选择器地址不可达 | 待修 | `select_inquiry_form_fields` 到达 MCP 后返回 `success=false`；页面为 `http://127.0.0.1:8000/demand-field-selector` | 远程 MCP 返回的回环地址指向宿主本机，而宿主没有该页面 | 使用可配置且可访问的 URL，或返回字段 schema 让宿主渲染原生表单 |
| `run_id` 类型未闭环 | 待生产确认 | 本地契约当前只接受正整数字符串；虚构 ID 分别出现 `INVALID_INPUT`、`INVALID_FILTER_VALUE`、`RUN_NOT_FOUND` | 本地校验与 provenance 已完成，但尚无真实成功 `rank_creators.run_id` 证明上游类型 | 用真实成功响应统一 Provider、Spec、Hook 和下游工具类型 |
| prompts 契约不一致 | 待修 | `prompts_list`、`prompts_get` 不在正式契约中 | 与 resources 相同，capability 宣告和可调用面不一致 | 不支持就停止暴露；支持就补 prompts capability 契约、wrapper 和测试 |

### 已确认边界

- `npm run verify:provider:prod` 只验证生产 MCP 的 15 个业务 Tool 和输入 schema，不执行业务调用，不能证明上述运行时问题已修复。
- `select_inquiry_form_fields` 的失败发生在页面打开阶段，没有业务写入。

---

## 四、Provider 与数据库

| 问题 | 优先级 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| 向量配置缺失、硬筛为 0 | P0 | `vector_config_missing`、`total_matched=0`、`supply_risk_level="high_risk"`；价格排除 443 条、返点排除 283 条 | 生产搜索没有可用向量配置，硬筛又把现有供给全部排除 | 检查向量配置，并核对报价、返点字段的数据分布和业务口径 |
| 宽价格仍排除全部达人 | P0 | `kolOfficialPriceL1="[0,99999999]"` 仍产生 `FIELD_NOT_MATCHED:kolOfficialPriceL1`（443 条）和 `total_matched=0` | 很可能存在字段缺失、单位/格式不一致或范围比较逻辑错误 | 抽样检查真实值、NULL 比例、人民币单位和比较方向，并区分字段缺失与超出范围 |
| 搜索响应没有权威工作流状态 | P0 | `success=true`、`candidate_pool_written=true`，但 `workflow_state=null`、`allowed_actions=[]` | 写池响应没有返回与数据库一致的 phase、state version 和 allowed actions | 所有成功写池响应返回同一事务提交后的唯一状态快照；0 候选明确返回 blocked/high-risk |
| 风险、门禁和状态版本没有原子落库 | P0 | 搜索为 `high_risk` 且写池成功；恢复却为 `risk_level=null`、`pending_gate=null`、`state_version=1`，并曾错误允许 `rank_mcns/manual_source_creators` | 搜索事实和恢复状态互相矛盾 | 将候选池、风险、pending gate 和 state version 在同一事务中持久化，`allowed_actions` 从同一快照派生 |
| 不存在或无关联的 ID 也能写库 | P0 | 历史错误写入返回 `success=true`、`operation="created"`、`sync_id=1`，trace `c8c0631e-137b-4b47-8554-7aa8070c2a57` | Provider 写库前没有验证 requirement、project、MCN 的存在性、归属和关联关系；也缺少完整服务端幂等/对账机制 | 对每个写工具增加服务端存在性、所有权/关联关系、幂等键和事务校验；本地 Hook 仅作为纵深防御 |
| MCN 和询价前置数据缺失 | P1 | `NO_MCN_MATCHED`、`existing_candidate_count=0`、`candidate_mcn_count=0`、`INQUIRY_NOT_FOUND` | 当前没有候选达人可映射到 MCN，也没有关联询价单，无法生成后续真实业务 ID | 优先修复检索并准备隔离测试 MCN/询价数据；未确认测试联系人前不向生产联系人外发 |

### 最新有效复现

| 需求 | Search trace | State trace | 结果 |
|---|---|---|---|
| `9d8644a67f98483696cfb03d71cc2dc4` | `aeeaae97-1445-4c56-bd1d-77263e4a384d` | `2d21b9c4-4f48-4cc8-84b0-7cfbbfdd6330` | 搜索仍为 `vector_config_missing`、硬筛 0、high risk；恢复状态丢失 risk/pending gate，`state_version=1` 并错误允许后续动作 |
| `d41c22f86573415c858feb3dbed6e8f0` | `1d0b0328-a561-4358-b583-82aeef03a274` | `e7ff1491-8955-4bf4-b2d3-7568f8f95192` | 宽价格仍为 0 匹配；恢复状态同样不完整 |

### 数据处理说明

- `sync_id=1` 是错误测试记录；当前没有安全删除契约，因此未擅自清理，也未用于后续测试。
- `get_workflow_state` 能派生 `candidate_pool_ready` 不代表状态正确；风险、门禁和 state version 仍必须与搜索事务一致。
- `manual_source_creators` 使用真实 requirement ID 到达远程 MCP 后返回 `INQUIRY_NOT_FOUND`（trace `48f2a61b-2c19-4b85-b391-630adfa094ff`），未重试、无写入。

---

## 建议修复顺序

| 顺序 | 要修什么 | 验收标准 |
|---|---|---|
| 1 | 修复宽价格仍为 0，并补齐向量配置 | 宽范围能命中符合条件的真实达人；向量可用或按契约明确降级，排除原因可解释 |
| 2 | 修复搜索写池、风险门禁和状态版本的原子持久化 | 搜索响应与随后 `get_workflow_state` 的 phase、risk、pending gate、version、allowed actions 完全一致 |
| 3 | Provider 增加服务端 ID 完整性和幂等校验 | 不存在、跨需求或无关联 ID 均无法写入；重复请求不会产生重复记录 |
| 4 | 补齐并正式声明 `search_creators` 供给方案输出 | 十个供给字段均由 Provider 返回并通过输出 schema/契约测试 |
| 5 | 统一 resources/prompts 与正式契约 | initialize capability、宿主 wrapper、Spec 和 Hook allowlist 来自同一声明且调用结果一致 |
| 6 | 修复字段选择器 URL | 目标宿主可实际打开页面，或能用返回 schema 渲染原生表单 |
| 7 | 用真实成功链路闭环 `run_id` 类型 | `rank_creators` 真实返回值能通过 Spec、Hook 和全部下游工具 |
| 8 | 引入确定性 requirement 解析/预览 | taxonomy、targetField、atom 明细、gate 和 summary 在重复运行中稳定一致，标准 Brief 确认前不调用任何 Tool |

## 与开发需求清单的对应关系

对照 `/Users/jasper/Documents/Obsidian/work/01 日报和周报/20260717-01-skill手写规则.md`：

- **工具面一致性（原清单 286-287）**：仍未完成；resources/prompts 可见，但正式契约只允许 15 个业务 Tool。
- **完整条件检索（原清单 227-230）**：仍未完成；“母婴/亲子”没有唯一 taxonomy 映射，向量检索又因 `vector_config_missing` 降级。
- **账号类型/内容标签 OR**：仍未定义；保留原文不会自动形成搜索条件。
- **供给数量模型**：消费端门禁已完成，Provider 响应和正式输出契约仍未闭环。
- **状态权威闭环**：仍为 P0；写池成功、空 workflow state、高风险未落库和 state version 不递增同时存在。
