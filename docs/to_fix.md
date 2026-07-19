# 实机测试待修问题

> 测试日期：2026-07-18  
> 环境：OpenClaw + YPmcn 3.0.8  
> 说明：本文件以 2026-07-19 最新 Live E2E 为准；已修复项只在仍影响复测边界时保留证据。

## 当前阻塞项

1. `search_creators` 仍出现 `vector_config_missing`，价格放宽到 `[0,99999999]` 后仍匹配不到达人。
2. Provider 代码与 `mcn_recommendation_items` 实际表结构漂移，MCN 排名、状态恢复和达人精排均被未知列错误阻断。
3. 搜索响应、恢复状态和 Hook 判断不一致，风险、门禁和状态版本没有形成权威闭环。
4. OpenClaw 暴露 resources/prompts，但插件正式契约只允许 15 个业务 Tool。
5. Provider 写入前没有校验业务 ID 是否真实存在、互相关联，也没有完整的服务端幂等与对账保护。

Skill 和 Hook 已提供 fail-closed 止血措施，但不能代替 MCP、Provider 和数据库侧修复。

---

## 一、Skill 与测试环境

| 问题 | 状态 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| Gateway 协议不匹配 | 暂不修 | `GatewayClientRequestError: protocol mismatch`；用户 PATH 中 OpenClaw 为 `2026.6.6`，18789 端口 Gateway 使用不同协议版本 | 用户手工环境仍可能无法通过 Gateway 模式运行 | OpenClaw 只用于测试时使用可工作的隔离 CLI/模式；正式使用前统一 CLI 与 Gateway 版本 |
| YP Action 安装原生 Plugin 时不导入包内 MCP | 宿主待修，当前显式配置 | 2026-07-19 在无预存 MCP 的 YP Action `2026.7.1` 安装 YPmcn `3.1.5`：Plugin/Skill 成功，安装目录含 `.mcp.json`，但 MCP Store 不自动增加服务；显式创建 `ypmcn-mcp` 后 Gateway 加载成功 | YP Action 安装器没有读取 `.mcp.json`，也没有 Plugin 与 MCP 的更新、卸载归属 | 宿主实现经过校验的导入/更新/卸载；修复前按《高效联调测试指南》§4.1 显式创建，禁止 Plugin 安装脚本或直改 SQLite |
| 默认模型鉴权失败 | 未修复，测试已绕过 | `HTTP 401 invalid_api_key`；原模型 `openai/gpt-5.5` | 默认 OpenAI 凭证仍失效 | 测试暂用 `deepseek/deepseek-v4-flash`；正式环境更新凭证或默认模型配置 |
| 插件信任来源不明确 | 暂不修 | 手工环境曾报告 `plugins.allow is empty`、`loaded without install/load-path provenance` | 用户手工安装环境没有统一的 allowlist 和可审计安装来源 | 正式部署时补 `plugins.allow` 并统一安装来源；仓库自动 smoke 的隔离安全基线不能替代手工环境配置 |
| 标准 Brief 确认前调用宿主/非契约工具 | 已修复 | 当前 Hook 明确放行 Skill、`read`、resources、prompts 和非外发 Tool；回归覆盖 unresolved/ready 两种 preview | preview 仍是提示上下文，不是权限边界 | 仅在 `create_with_distributions` 真正外发前发起绑定参数的 AskUserQuestion，不再追求确认前零 Tool 调用 |
| “母婴/亲子” taxonomy 解析预览不稳定 | 部分修复 | 确定性 preview 继续保留原子与歧义信息；Hook 不再重复校验 taxonomy | Provider 仍需提供合法 taxonomy 值并拒绝非法映射 | 由解析器、正式 taxonomy 契约和 Provider 校验闭环，不恢复本地全局 Tool 门禁 |
| 解析原子明细与汇总计数不稳定 | 部分修复 | preview 与 ready payload 由同一确定性 atom 列表生成；Hook 不再校验普通 requirement payload | 新自然语言样本仍可能暴露解析差异 | 保留 parser/golden 回归，最终参数正确性由 MCP/Provider 校验 |

### 当前边界

- 最新包三次全新会话解析稳定性测试为 **0/3 满足完整验收**：一次擅自调用 `read/prompts_get`；一次遗漏 payload/audit/coverage 并错误映射 taxonomy；一次识别歧义但未输出正式 `rawMessagesJson`，日期也未补齐 schema 要求的秒。
- 三轮历史测试均未产生 YPmcn 业务写入；当前不再用本地 Hook 代替 taxonomy、schema 或 audit 的 Provider 校验，也不能据此把调用前文本预览视为生产成功证据。
- JSON taxonomy 字段的合法值集合仍需由 Provider/数据契约提供，不能由 Skill 猜测。
- 仓库自动测试已隔离 OpenClaw 状态和配置；用户手工运行不同版本 OpenClaw 时仍应使用 `--profile` 或显式设置 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`。

---

## 二、Hooks 与能力契约

| 问题 | 状态 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| 手工 OpenClaw 环境安全审计未通过 | 手工环境待处理 | 历史 deep audit：`critical=1, warn=5, info=1`；仓库隔离 smoke 已达到 `summary.critical=0` | 自动测试安全基线不会修改用户全局认证、trusted proxies、插件来源和工具策略 | 在目标手工/正式环境单独配置并复跑 deep audit |
| Capability 与正式 allowlist 不一致 | Hook 侧已修复 | Hook 不再把 resources/prompts 或未知 wrapper 当业务 Tool 校验，相关调用默认放行 | Endpoint 是否真实支持 capability 仍由宿主/MCP 协商决定 | 保持 Hook 只识别最终外发 Tool；capability 兼容性在宿主与 Provider 层验证 |
| 已提交弹窗选项只被回复“已确认” | 已修复 | 当前回归把供给、MCN 和字段弹窗的已提交选项记为本地 `next_action`；Agent 指令要求同轮执行选中动作 | Provider 后端错误仍可能让业务链停止 | 弹窗选项保持明确动词，回归覆盖提交结果到下一动作的转换 |
| 需求确认弹窗不换行、术语过多 | 已修复 | 当前解析与回归要求用户侧只显示“小红书图文/视频”或“抖音1–20秒/21–60秒/60秒以上”，小红书禁止第三档；本地回归已覆盖 | 宿主自带的弹窗布局不由本插件控制 | 保留简短单句和平台业务语义，禁止恢复用户可见 L1/L2/L3 |
| 明确的 L1 官方报价被误判为缺失 | 已修复 | 3.1.6 解析器接受“单达人 L1 官方报价：4万元以内”，直接映射 `kolOfficialPriceL1=[0,40000]`，明确截止同时保持 `2026-07-20 18:00:00`；安装后只读 UI 会话 `55d827cc-9d13-41f8-8c5d-93164e875abd` 复测为 ready 且未弹窗 | 未覆盖的新自然语言写法仍应 fail closed | 保留原文 atom 和确定性解析回归；仅对明确档位映射 |
| 未绑定真实数据的供给确认可被模型直接弹出 | 策略已调整 | `search_creators` 成功后先用固定格式展示真实供给数、需求数、供需比和建议拓展数，再弹出供给确认；普通供给交互不由 Hook 阻断 | Provider 仍需返回真实供给数据，Agent 不得自行伪造 | 不可逆企微外发由 AskUserQuestion 问题指纹与后续 Tool 参数指纹共同绑定；供给弹窗作为业务命令执行 |

### Hook 不能替代的 Provider 校验

- 本地 Hook 不再维护 `kwUid/requirement_id/project_id/mcn_id/inquiry_id/run_id` provenance ledger，也不阻断普通业务 Tool。
- ID 存在性、归属和关联关系由 Provider/数据库校验；Agent 仍只能复用真实成功响应中的 ID。
- Provider 仍必须在每个业务写入前执行存在性、所有权/关联关系和幂等校验。

---

## 三、MCP 工具

| 问题 | 状态 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| `search_creators` 供给方案字段不全 | 部分修复，Live E2E 阻塞 | 最新需求 `1784430089674707` 返回真实候选 377、需求 1、供给倍数 377、5 家机构，trace `41318ff4-48dc-4440-9f3b-9cd04ea954b1`；受控核验 trace `6d0bdc7d-7ab6-4471-9696-70a0177f7598`，仍缺五个计划字段 | 本次仅按用户授权用明确标记的 `synthetic_test_only` 数值隔离下一故障，不是生产修复 | Provider 返回全部十个供给字段并声明输出 schema；部署后用全新项目重跑 |
| 排名与状态工具使用不存在的 MCN 推荐列 | P0，Live E2E 阻塞 | 最新 3.1.5 UI 链已完成真实需求写入、搜索和绑定确认；`rank_mcns` 随后仍因 pymysql 未知列 `mcn_run_id` 返回 `INTERNAL_ERROR`，trace `728bc307-dcd9-46cc-aa4e-4a44e92a22e4`，并通过原生“服务异常”弹窗安全结束 | Provider ORM/SQL 与实际数据库迁移版本不一致；未生成排名，不能继续企微外发 | 对齐迁移、ORM 和实际表，补 schema 启动检查与事务回滚测试，再用新测试需求单次重跑 |
| resources 契约不一致 | 待修 | Probe 显示 `resources: true`，调用 `resources_list` 却不在正式契约中 | 宿主宣告可用，插件又拒绝调用 | 不支持就停止暴露；支持就补 resources capability 契约、wrapper 和测试 |
| 字段选择器地址不可达 | 待修 | 2026-07-19 受控直连再次返回 `success=false`；页面仍为 `http://127.0.0.1:8000/demand-field-selector`，实时工具描述也只声明“打开网页并等待提交” | 远程 MCP 返回的回环地址指向宿主本机，既没有可访问页面，也没有可供宿主安全生成 `columns` 的字段清单 | 使用可配置且可访问的 URL，或返回字段 schema 让宿主渲染原生表单 |
| `run_id` 类型未闭环 | 待生产确认 | 本地契约当前只接受正整数字符串；虚构 ID 分别出现 `INVALID_INPUT`、`INVALID_FILTER_VALUE`、`RUN_NOT_FOUND` | 本地校验与 provenance 已完成，但尚无真实成功 `rank_creators.run_id` 证明上游类型 | 用真实成功响应统一 Provider、Spec、Hook 和下游工具类型 |
| prompts 契约不一致 | 待修 | `prompts_list`、`prompts_get` 不在正式契约中 | 与 resources 相同，capability 宣告和可调用面不一致 | 不支持就停止暴露；支持就补 prompts capability 契约、wrapper 和测试 |

### 已确认边界

- `npm run verify:provider:prod` 只验证生产 MCP 的 15 个业务 Tool 和输入 schema，不执行业务调用，不能证明上述运行时问题已修复。
- `select_inquiry_form_fields` 的失败发生在页面打开阶段，没有业务写入。

---

## 四、Provider 与数据库

| 问题 | 优先级 | 当前证据 | 剩余问题 | 处理方式 |
|---|---|---|---|---|
| `mcn_recommendation_items` Schema 漂移 | P0 | `rank_mcns` 只读排序成功，证明计算路径可用；INSERT 仍需要实际表不存在的 `mcn_run_id`，`get_workflow_state`、`rank_creators` SELECT 需要不存在的 `item_id`；trace 见上节 | MCN 排名不能持久化、工作流不能恢复、达人精排不能开始；失败写入是否已完整回滚也无法由当前状态工具核验 | 先核对生产 migration head 和实际 `SHOW CREATE TABLE`，统一列名/主键/外键，再增加启动期 schema compatibility check 与事务回滚断言 |
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
- 2026-07-19 的 `rank_mcns` 只直连调用一次，收到数据库错误后未重试；由于 `get_workflow_state` 同样受 Schema 漂移阻断，必须由 Provider 日志/数据库事务记录核对该失败写入是否完整回滚。
- 后续合成供给方案只用于验证 `rank_mcns(write_mcn_recommendation_items=false)`；测试后确认状态已清空。该成功响应返回的 `mcn_run_id=0ca789b7d3ba4261a15e9b34c7fa3cf2` 没有持久化，禁止传给任何下游工具。
- `get_workflow_state` 能派生 `candidate_pool_ready` 不代表状态正确；风险、门禁和 state version 仍必须与搜索事务一致。
- `manual_source_creators` 使用真实 requirement ID 到达远程 MCP 后返回 `INQUIRY_NOT_FOUND`（trace `48f2a61b-2c19-4b85-b391-630adfa094ff`），未重试、无写入。

---

## 建议修复顺序

| 顺序 | 要修什么 | 验收标准 |
|---|---|---|
| 1 | 对齐 `mcn_recommendation_items` 迁移、ORM 和实际表 | `rank_mcns` 可原子落库，`get_workflow_state` 与 `rank_creators` 不再出现未知列；失败事务有可验证回滚 |
| 2 | 修复宽价格仍为 0，并补齐向量配置 | 宽范围能命中符合条件的真实达人；向量可用或按契约明确降级，排除原因可解释 |
| 3 | 修复搜索写池、风险门禁和状态版本的原子持久化 | 搜索响应与随后 `get_workflow_state` 的 phase、risk、pending gate、version、allowed actions 完全一致 |
| 4 | Provider 增加服务端 ID 完整性和幂等校验 | 不存在、跨需求或无关联 ID 均无法写入；重复请求不会产生重复记录 |
| 5 | 补齐并正式声明 `search_creators` 供给方案输出 | 十个供给字段均由 Provider 返回并通过输出 schema/契约测试 |
| 6 | 统一 resources/prompts 与正式契约 | initialize capability、宿主 wrapper、Spec 和 Hook allowlist 来自同一声明且调用结果一致 |
| 7 | 修复字段选择器 URL | 目标宿主可实际打开页面，或能用返回 schema 渲染原生表单 |
| 8 | 用真实成功链路闭环 `run_id` 类型 | `rank_creators` 真实返回值能通过 Spec、Hook 和全部下游工具 |
| 9 | 引入确定性 requirement 解析/预览 | taxonomy、targetField、atom 明细、gate 和 summary 在重复运行中稳定一致，标准 Brief 确认前不调用任何 Tool |

## 与开发需求清单的对应关系

对照 `/Users/jasper/Documents/Obsidian/work/01 日报和周报/20260717-01-skill手写规则.md`：

- **工具面一致性（原清单 286-287）**：仍未完成；resources/prompts 可见，但正式契约只允许 15 个业务 Tool。
- **完整条件检索（原清单 227-230）**：仍未完成；“母婴/亲子”没有唯一 taxonomy 映射，向量检索又因 `vector_config_missing` 降级。
- **账号类型/内容标签 OR**：仍未定义；保留原文不会自动形成搜索条件。
- **供给数量模型**：消费端门禁已完成，Provider 响应和正式输出契约仍未闭环。
- **状态权威闭环**：仍为 P0；写池成功、空 workflow state、高风险未落库和 state version 不递增同时存在。
