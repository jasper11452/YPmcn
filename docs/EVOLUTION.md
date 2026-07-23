# 演进历程：为什么现在要区分“契约、代码、远端”

这不是发布日志的替代品，而是帮助新同事理解当前设计选择的导读。具体的已批准历史在下方的 `changes/` 索引中；当天能否联调或上线，请先看[集成与上线就绪](integration-readiness.md)。

## 这套结构解决了什么问题

项目早期同时有 Mock MCP、直发企微脚本、多个 worktree、嵌套 Spec 和历史方案。最大的风险不是代码量，而是很容易把“本地做过一次”“旧文档说过”误认为“今天的远端已经支持”。

现在的结构把事实拆开：

1. **先写清规则**：`mvp-v2` 把目标行为固化到根 `spec/`。远端旧 Provider 只能被检测兼容性，不能因为名字相近就自动降级或猜参数。
2. **只保留一个项目根**：根目录管理 Spec、测试、打包和决策；`YPmcn/` 只是可发布插件组件。这样不会出现两份“看起来都像正式配置”的文件。
3. **把本地编排和业务事实分开**：插件可以记录当前走到哪一步，却不能把本地状态当成数据库写入或企微发送成功。真实证据必须来自 Provider 响应和服务端对账。
4. **收紧外部副作用的证据**：当前 `create_with_distributions` 是直接 MCP 调用，不再由插件弹本地二次确认。因而“是否已发送”只能依赖逐机构的 Provider 回执，不能依赖弹窗、Local JSON 或后续 sync。
5. **清理和可重复验证**：旧 Mock/直发链路、客户内容和废弃产物不再作为运行路径；根 npm workspace 让干净工作树可通过一次 `npm ci` 安装。
6. **把人类文档和机器契约分工**：自动区块提示 Spec 漂移，人工文档解释当前限制和正确操作。脚本能比对哈希，不能判断一段历史结论是否还适用。

一个典型变化：早期文档把“本地确认弹窗出现”当作外发安全证据；当前实现改为直接调用后，这条证据已失效。今天要判断外发成功，必须看 Provider 返回的、可对应每个供应商的 `sent` 明细。

## 已批准变更索引

<!-- human-docs:change-index:start -->
<!-- 由 pre-commit hook 或 npm run docs:sync 生成；不要手工编辑本区块。 -->

当前 Spec：`mvp-v2` · `sha256:f3584e81f3a927b8113acd498a49c47b415ec08797788f1a25858c1c7ef93c45`
变更记录摘要：`sha256:daf5e307afddc2d5a3dc3904f9dc402d9a96100fcbc78b063c45c33f1b3d1961`

| 变更 | 状态 | 决策主题 |
| --- | --- | --- |
| CHG-2026-026 | `IMPLEMENTED_LOCAL_VERIFIED` | [企微外发最近确认直接续发](../changes/CHG-2026-026-last-approved-external-send.md) |
| CHG-2026-025 | `IMPLEMENTED_LOCAL_VERIFIED` | [企微外发确认跨轮回执](../changes/CHG-2026-025-external-send-cross-turn-confirmation.md) |
| CHG-2026-024 | `IMPLEMENTED_LOCAL_HOST_UNVERIFIED` | [发布 3.4.13 手动拓展证据链修正版](../changes/CHG-2026-024-release-3.4.13.md) |
| CHG-2026-023 | `IMPLEMENTED_LOCAL_HOST_UNVERIFIED` | [发布 3.4.12 工具链路与状态机加固包](../changes/CHG-2026-023-release-3.4.12.md) |
| CHG-2026-022 | `IMPLEMENTED_LOCAL_HOST_UNVERIFIED` | [发布 3.4.11 宿主无关手扒回执修复包](../changes/CHG-2026-022-release-3.4.11.md) |
| CHG-2026-021 | `IMPLEMENTED_LOCAL_HOST_UNVERIFIED` | [发布 3.4.10 Human-in-the-loop 修复包](../changes/CHG-2026-021-release-3.4.10.md) |
| CHG-2026-020 | `IMPLEMENTED_LOCAL_HOST_UNVERIFIED` | [统一 Human-in-the-loop 与自动续接](../changes/CHG-2026-020-human-in-the-loop.md) |
| CHG-2026-019 | `IMPLEMENTED_LOCAL_HOST_BLOCKED` | [修复需求主键、Brief 绑定与搜索供给契约](../changes/CHG-2026-019-runtime-id-and-supply-contract.md) |
| CHG-2026-018 | `IMPLEMENTED_LOCAL_PROVIDER_UNVERIFIED` | [拓展达人调用绑定当次新需求 ID](../changes/CHG-2026-018-fresh-manual-requirement.md) |
| CHG-2026-017 | `IMPLEMENTED_LOCAL_PROVIDER_BLOCKED` | [字段选择后直接拓展达人并导出](../changes/CHG-2026-017-direct-manual-export.md) |
| CHG-2026-016 | `IMPLEMENTED_LOCAL_PROVIDER_BLOCKED` | [赛后决定精确拓展达人补量](../changes/CHG-2026-016-post-race-manual-sourcing.md) |
| CHG-2026-015 | `IMPLEMENTED_LOCAL_PROVIDER_BLOCKED` | [高风险供给启动达人拓展](../changes/CHG-2026-015-manual-sourcing-workflow.md) |
| CHG-2026-014 | `IMPLEMENTED_LOCAL_TEST_ONLY` | [本地独立向量管线](../changes/CHG-2026-014-local-vector-integration.md) |
| CHG-2026-013 | `SPEC_APPROVED` | [建立向量检索 MVP 正式契约基线](../changes/CHG-2026-013-vector-contract-baseline.md) |
| CHG-2026-011 | `SPEC_APPROVED` | [修正 Hook 与 OpenClaw 宿主接口对接](../changes/CHG-2026-011-hook-host-integration.md) |
| CHG-2026-010 | `SPEC_APPROVED` | [Reference MCP 实现正式输出与恢复契约](../changes/CHG-2026-010-reference-mcp-runtime.md) |
| CHG-2026-009 | `SPEC_APPROVED` | [Hook / Skill 消费服务端权威状态](../changes/CHG-2026-009-hook-skill-authority.md) |
| CHG-2026-008 | `SPEC_APPROVED` | [锁定业务 MCP canonical namespace](../changes/CHG-2026-008-mcp-namespace.md) |
| CHG-2026-007 | `SPEC_APPROVED` | [固化 P0 与首批 P1 正式契约](../changes/CHG-2026-007-contract-closure.md) |
| CHG-2026-005 | `SPEC_APPROVED` | [将人类文档同步改为提交前自动执行](../changes/CHG-2026-005-automatic-human-docs.md) |
| CHG-2026-004 | `SPEC_APPROVED` | [建立极简人类文档与 Spec 同步门禁](../changes/CHG-2026-004-human-documentation.md) |
| CHG-2026-003 | `SPEC_APPROVED` | [修复根目录干净安装入口](../changes/CHG-2026-003-root-workspace-install.md) |
| CHG-2026-002 | `SPEC_APPROVED` | [退役旧链路并清理仓库](../changes/CHG-2026-002-repository-cleanup.md) |
| CHG-2026-001 | `SPEC_APPROVED` | [统一项目目录与 Spec 权威入口](../changes/CHG-2026-001-repository-layout.md) |
<!-- human-docs:change-index:end -->

## 怎样读下面的变更索引

- `SPEC_APPROVED`：规则已经批准，不等于代码、远端服务或生产环境已经可用。
- `IMPLEMENTED_LOCAL_*`：本地实现或测试有对应证据；其中 `HOST_UNVERIFIED`、`PROVIDER_UNVERIFIED`、`PROVIDER_BLOCKED` 都明确表示还不能当作外部环境成功。
- 变更编号按决策时间排列，不是“最新的编号必然覆盖全部旧行为”。判断现状时仍以当前 Spec、插件实现和[运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)为准。

## 当前方向

- 继续遵循 Change Proposal → Spec → 实现 → 验证的顺序；涉及外部写入、ID、流程阶段、权限或恢复时，不把文档示例当成授权。
- 上线前最关键的缺口是：让远端 Provider 的输入契约与批准 Spec 对齐、获得可审计的成功出参/对账证据、完成隔离环境 E2E；数据库生产迁移、并发证明和算法定义也仍需补齐。
- 当前向量路线是 Qdrant 作为派生召回索引；它不拥有业务写入权。旧 DashVector 方案只保留作历史参考。
- 需要考古时看 `changes/` 和 Git；活跃 `docs/` 必须明确写出“当前”“历史”或“待验证”，避免历史结论重新变成默认操作。
