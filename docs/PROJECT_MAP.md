# 项目地图

这张地图解决两个最常见的问题：**改动该落在哪一层**，以及**哪个结果才算真实业务事实**。

## 先看系统怎么连起来

```text
媒介 / Host
   │  mcp__ypmcn__<bare-tool>
   ▼
YPmcn 插件（Skill + 4 个 Node Hook）
   │  提示、前置校验、调用记录；不拥有业务成功事实
   ▼
远端 Business MCP（bare tool name）
   │  业务写入、读取、外发结果
   ├──────────────► MySQL：业务主数据与权威记录
   └──────────────► Qdrant：可选的派生召回索引
                         │
                         └─ 搜索结果必须回到 MySQL 复水并重新校验

本地会话状态 JSON
   └─ 只保存“这一轮走到哪一步、下一步建议做什么”；不能证明数据库已写入或企微已发送
```

例如，`create_with_distributions` 先通过本地确认，才会真正调用 Provider；确认回执只说明有人批准了这次外发，不能说明消息已发。即使 Provider 返回一个泛化的 `success` 也还不够：只有该次响应中能对应请求机构的明确 `sent` 明细，才是外发证据；后续 `sync_mcn_inquiry_status` 只能证明同步，不会补造发送证据。

## 目录与责任

| 位置 | 负责什么 | 人工检查重点 |
| --- | --- | --- |
| `.githooks/` | 提交时同步机器事实区块 | 不要因为部分暂存而扩大提交范围 |
| `spec/` | 唯一正式机器契约 | 字段、工具、阶段、错误和副作用是否一致 |
| `changes/` | 为什么改、影响什么、何时批准 | 明确区分已实施、仅本地验证和历史决策 |
| `YPmcn/` | 可发布插件组件（Skill、Hook、工具参考） | 是否只做契约允许的提示/守卫/编排 |
| `tests/` | 仓库级验证 | 是否证明了声明的边界，而不是只迁就实现 |
| `scripts/` | 验证、同步、打包 | 是否只读、确定性、没有隐式生产写入 |
| `docs/` | 给人看的当前指南、审计与历史说明 | 当前状态、证据范围、示例是否说清楚 |
| `packages/` | staging 与发布包 | 只放生成物，不放可编辑源码或第二份 Spec |
| `fix-logs/` | 重要故障的根因和预防措施 | 是否能复用，而非把临时排查当规则 |

`YPmcn/` 是组件目录，不是第二个项目根。根目录统一管理依赖、Spec、测试、打包和文档。

## 正式契约地图

<!-- human-docs:contract-map:start -->
<!-- 由 pre-commit hook 或 npm run docs:sync 生成；不要手工编辑本区块。 -->

Spec 摘要：`sha256:f3584e81f3a927b8113acd498a49c47b415ec08797788f1a25858c1c7ef93c45`

| 领域 | 唯一权威 | 人类理解 |
| --- | --- | --- |
| database | [`spec/database.json`](../spec/database.json) | 表、不变量与写入归属 |
| mcp | [`spec/mcp.json`](../spec/mcp.json) | Tool、输入输出、错误与副作用 |
| hooks | [`spec/hooks.json`](../spec/hooks.json) | 确定性守卫与生命周期事件 |
| skills | [`spec/skills.json`](../spec/skills.json) | Skill 可用 Tool、前置条件与禁区 |
| workflow | [`spec/workflow.json`](../spec/workflow.json) | 阶段、转换与恢复顺序 |
| errors | [`spec/errors.json`](../spec/errors.json) | 错误码、重试与对账语义 |
| requirements | [`spec/requirements.json`](../spec/requirements.json) | 正式契约 |
| algorithms | [`spec/algorithms.json`](../spec/algorithms.json) | 算法定义就绪状态 |
<!-- human-docs:contract-map:end -->

这些文件定义“应当如此”。若要知道远端今天实际发布什么，请读[远端 MCP 运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)，不要用本地 Spec 反推线上已兼容。

## 遇到变化时，先去哪里

| 你想改的事 | 第一落点 | 随后必须核对 |
| --- | --- | --- |
| Tool 参数、返回、错误或副作用 | `spec/mcp.json` | Skill 工具卡、Hook、测试、Provider 差异 |
| 工作流阶段、等待或恢复顺序 | `spec/workflow.json` | 本地状态投影、相邻转换测试 |
| 写表、幂等、主键与不变量 | `spec/database.json` | Provider/数据库的外部证据 |
| 需求字段、字典、金额/日期、跨平台拆分 | `spec/requirements.json` | `requirement-dictionary.json`、Schema、错误映射 |
| Skill 可以调用什么、何时调用 | `spec/skills.json` | `YPmcn/skills/` 与工具参考 JSON |
| Hook 事件或阻断条件 | `spec/hooks.json` | `YPmcn/src/index.ts`、`runtime-hooks.ts`、原生 Hook 测试 |
| 向量召回或重排规则 | `spec/algorithms.json` | 必须先确认其不是 `external-unverified` |
| 只改解释、示例或排版 | 相应 `docs/` 文件 | 链接、当前事实、`npm run verify:docs` |

一个边界例子：把 `manual_source_creators.size` 从字符串改成数字，不是“只改提示词”。它会改变 Tool 契约，应从 `spec/mcp.json` 和 Provider 兼容性开始；而把文档里的旧参数名 `target_count` 更正为 `size`，只需要改文档并核对工具卡。

## 当前 Hook 和状态的边界

目前的 4 个 Hook 分工如下：

| 事件 | 做什么 | 不做什么 |
| --- | --- | --- |
| `before_prompt_build` | 整理真实 Brief、注入流程提示、读取本地编排投影 | 不写业务数据，不判定 Provider 成功 |
| `before_tool_call` | 检查 Brief/需求 ID、一次性人工拓展凭据和外发确认回执，阻止 shell 绕过 | 不把确认回执当成 Provider 发送成功 |
| `after_tool_call` | 从实际调用结果更新本地阶段和下一步 | 不把泛化成功改写成外发或数据库成功 |
| `session_end` | 尝试清理过期本地状态 | 不做业务恢复或补偿写入 |

所以“状态管理”分成了两种：插件的**本地编排状态**帮助下一轮继续，也保存“外发已请求确认 / 已确认 / 已调用”的一次性回执；Provider 的**业务状态**才是可对账的事实。排查问题时先问“缺的是哪一种状态”，再决定看本地 JSON、MCP 原始响应还是数据库/Provider 证据。

## 三个不要混淆

- `mcp__ypmcn__<contract-tool>` 是 Host 看到的业务工具身份；Provider `tools/list` 里是 bare name。二者不同不代表是两个工具。
- 本地测试、Spec 已批准、远端 Provider 兼容是三个独立门禁。前两个通过，远端仍可能阻断上线。
- 发布包中的 `spec/` 是构建快照；可编辑事实源永远是根目录 `spec/`。

Spec 或正式 Change Proposal 完整暂存后，pre-commit 会更新本页的自动事实区块。`npm run docs:sync` 只是预览/修复入口，`npm run verify:docs` 只检查这些自动区块，不会替你判断叙述是否还符合运行时。
