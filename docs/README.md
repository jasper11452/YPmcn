# 文档导航：先分清三件事

这里的 `docs/` 是给参与项目的人看的说明书：它回答“现在是什么状态、为什么这样做、下一步怎么判断”。它不替代根目录的 [`spec/`](../spec/README.md)：Spec 才是字段、工具、流程和错误码的正式机器契约。

阅读时请始终区分下面三层。很多误判都来自把其中两层混为一谈。

| 层次 | 它回答的问题 | 当前例子 |
| --- | --- | --- |
| 批准契约 | 系统**应该**怎样工作？ | `mvp-v2` 已批准；Host 使用 `mcp__ypmcn__<tool>` 调业务工具。 |
| 本地插件 | 仓库里的代码**已经做了什么**？ | 当前工作树的根和组件 manifest 都是 `3.4.25`；插件有 4 个 Node Hook，并保存本地编排投影。 |
| 远端 Provider | MCP **实际发布了什么**？ | 2026-07-23 审计到 15 个工具，但两个关键入参契约不兼容，且未发布 outputSchema。 |

## 先看结论

- YPmcn 帮媒介人员把需求确认、达人搜索、机构询价、机构回填、达人排序和提报串起来。插件负责提示、确定性前置校验和本地流程记录；远端 MCP/数据库才负责业务事实与真实写入。
- 正式契约 Profile 是 `mvp-v2`，状态是 `approved`。这表示“目标规则已经批准”，**不表示线上已经可发布**。
- 当前仍是 **NO-GO**：数据库只有开发环境观察证据，算法契约仍是 `external-unverified`；更关键的是，远端 Provider 与批准契约在 `create_submission_batch`、`get_workflow_state` 上存在硬性入参差异。
- 插件现在有 4 个生命周期 Hook，不是 4 套业务流程。它们只负责提示前准备、调用前守卫、调用结果记录和会话清理。业务顺序与业务成功不能只看本地状态文件。
- `create_with_distributions` 是当前受本地确认保护的外发调用：每次尝试前插件都会弹出确认；确认回执只放行下一次调用一次。这个回执证明“人已确认发起”，而不是“企微已送达”；只有 Provider 返回“逐机构明确已发送”的真实明细，才可以说企微已发出。

一个实用判断：如果本地测试通过，但远端 Provider 的 schema 检查失败，那么本地改动可以说“已验证”，却不能说“已上线”。

## 1 分钟阅读顺序

| 你想知道 | 先读 |
| --- | --- |
| 项目由什么组成、代码/契约该去哪找 | [项目地图](PROJECT_MAP.md) |
| 当前能否联调或上线、还缺什么 | [集成与上线就绪](integration-readiness.md) |
| 远端 MCP 真实接受什么参数、哪些不能调用 | [远端 MCP 运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md) |
| 一次典型业务流程怎样走 | [高效联调测试指南](高效联调测试指南.md) |
| 人工如何安全修改项目 | [开发者工作流](DEVELOPER_SPEC_WORKFLOW.md) |
| 执行 Agent 的边界和验收方式 | [Agent 工作流](AGENT_SPEC_WORKFLOW.md) |
| 为什么有这些历史方案、哪些已经失效 | [演进历程](EVOLUTION.md) |
| 向量检索现在走哪条路线 | [向量当前状态](REMOTE_VECTOR_DATABASE_STATUS_2026-07-17.md) |

## 当前机器事实

下面这块由脚本从 Spec 生成。它适合快速发现契约漂移，但不能替代上面的“当前状态”判断：例如 `development-observed` 只说明开发库有观察证据，并不等于生产证明。

<!-- human-docs:spec-summary:start -->
<!-- 由 pre-commit hook 或 npm run docs:sync 生成；不要手工编辑本区块。 -->

| 当前事实 | 值 |
| --- | --- |
| Profile / 状态 | `mvp-v2` / `approved` |
| 正式契约域 | 8 个 |
| MCP Tool | 15 个（必需 15，可选 0） |
| Workflow / Hook | 13 个阶段 / 4 个事件 |
| 数据库证明 | 6 项不变量，`development-observed` |
| 算法定义 | `external-unverified` |
| 兼容检测 | `legacy-1.9.4` |
| Spec 摘要 | `sha256:f3584e81f3a927b8113acd498a49c47b415ec08797788f1a25858c1c7ef93c45` |
<!-- human-docs:spec-summary:end -->

## 怎样把文档用在实际工作里

以“给某需求补一位达人”为例：

1. 先在[远端 MCP 运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)和工具卡中确认 `manual_source_creators` 当前接受 `requirement_id` 与字符串 `size`，不要从旧方案里的 `target_count` 猜参数。
2. 插件只接受刚刚由 `validate_requirement` 返回的 32 位 `data.id`；`demand_id` 和 `demand_version` 都不是这个 Tool 的替代品。
3. 如果在这之前已经开始 `search_creators`，就必须先完成当前 MCN 分支，不能跳到人工拓展绕过证据链。
4. 调用结果、Provider schema 检查和本地测试分别记录。它们回答的是不同问题，不能互相代替。

历史计划、故障记录和迁移方案可以帮助理解来路，但标题中标有“历史”“待验证”或日期快照的内容，不能直接当作今天的操作说明。

## 常用命令与含义

```bash
# 首次进入干净工作树：安装根工作区依赖
npm ci

# 离线契约、插件和发布包检查
npm run verify

# 只检查 docs 中自动生成的事实区块是否与 Spec 一致
npm run verify:docs

# 只读检查远端 Provider 输入契约；当前发现差异时失败是预期证据，不可忽略
npm run verify:provider:prod

# 生成并扫描可安装包
npm run pack:yp
```

正常提交时，完整暂存的 Spec 或正式 Change Proposal 会触发 pre-commit hook 更新三个自动事实区块。`npm run docs:sync` 仅用于提交前预览或修复；脚本无法判断一段中文叙述是否过时，所以仍要人工检查本页所说的三层证据。
