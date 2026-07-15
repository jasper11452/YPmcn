# 人类入口

这组文档只帮助人快速理解和检查项目，不替代根 [`spec/`](../spec/README.md)。

## 先看结论

- YPmcn 是一个契约优先的媒介助手仓库：Host 业务工具只接受 `mcp__ypmcn__<contract-tool>`，provider `tools/list` 保持 bare tool name；插件负责 Skill/Hook，provider 负责真实业务写入，vector MCP 负责向量检索。
- P0 与首批 P1 已收口为 Requirements、Database、MCP、Workflow、Error 和 JSON Schema 契约；这只是目标定义，不代表 provider、数据库或 Hook/Skill 已实现。
- 离线仓库可验证，但生产 provider 仍是旧契约，数据库证明与算法定义尚未完成，所以当前仍是 **NO-GO**。
- 唯一项目根就是当前 Git 仓库；`YPmcn/` 是组件，临时 worktree 不是第二个项目。

## 1 分钟阅读顺序

| 你想知道 | 先读 |
| --- | --- |
| 项目由什么组成、去哪改 | [项目地图](PROJECT_MAP.md) |
| 为什么形成现在的结构 | [演进历程](EVOLUTION.md) |
| 当前能否上线 | [集成与上线就绪](integration-readiness.md) |
| 人工如何改项目 | [开发流程](DEVELOPER_SPEC_WORKFLOW.md) |
| Agent 如何执行 | [Agent 流程](AGENT_SPEC_WORKFLOW.md) |
| 跨 Session 如何并行 | [控制面命令与状态](../workflows/README.md) |

## 当前事实

<!-- human-docs:spec-summary:start -->
<!-- 由 pre-commit hook 或 npm run docs:sync 生成；不要手工编辑本区块。 -->

| 当前事实 | 值 |
| --- | --- |
| Profile / 状态 | `mvp-v2` / `approved` |
| 正式契约域 | 8 个 |
| MCP Tool | 15 个（必需 14，可选 1） |
| Workflow / Hook | 14 个阶段 / 6 个事件 |
| 数据库证明 | 14 项不变量，`external-unverified` |
| 算法定义 | `external-unverified` |
| 兼容检测 | `legacy-1.9.4` |
| Spec 摘要 | `sha256:a433b316e438f2527b1d89a0d2de068bccb411242c1467a6b22e096e0da8f69a` |
<!-- human-docs:spec-summary:end -->

## 五条原则

1. 安全与数据完整性优先于所有规则。
2. 已批准 Spec 优先于 Change Proposal、测试、实现和 Agent 推断。
3. 契约变更先改 Spec，再按 Database → MCP → Hook/Skill → Test → Package 实施。
4. reference MCP 的模拟成功不是生产证据；provider 不兼容时保持 `integration_required`。
5. 完整 Brief、payload、凭据、生成物和旧实现不进入长期源码。

## 人类最常用的命令

```bash
npm ci
npm run verify
npm run pack:yp
```

正常不需要手动同步：完整暂存 Spec 或正式 Change Proposal 后直接提交，pre-commit hook 会更新并纳入三份文档。`npm run docs:sync` 仅用于提交前即时预览或修复；完成前仍要人工扫一遍叙事，并执行只读 `npm run verify:docs` 和完整验证。
