# 演进历程

## 为什么演进

项目早期同时存在旧 MockMCP、直发企微脚本、多个 worktree、历史文档和嵌套 Spec，人工与 Agent 都容易把实验实现当成当前事实。当前结构不是为了“目录好看”，而是为了消除双入口和错误生产证据。

## 关键转折

1. **契约优先**：把目标行为固化为 `mvp-v2`，线上旧 provider 只做兼容检测，不再自动降级。
2. **单一项目根**：正式 Spec 迁到根 `spec/`，组件、测试、产物和变更记录各归其位。
3. **安全清理**：退役旧 Mock/直发链路，移除完整客户数据、历史包、缓存和废弃分支。
4. **一键安装**：根 npm workspace 覆盖插件与向量 MCP，一次 `npm ci` 即可验证全仓库。
5. **人类可读**：保留极简叙事，Spec/Change 的机器事实在提交前自动同步，验证只负责检查漂移。
6. **契约收口**：把 2026-07-12 的 P0 与首批 P1 固化为数据实体、无客户内容字典、逐工具输出、服务端权威恢复和 closed-world 业务有效性契约，同时保持生产 NO-GO。
7. **业务命名空间**：Host 只以 `mcp__ypmcn__<contract-tool>` 识别业务工具；provider `tools/list` 继续协商 bare name，向量服务不得混入。

## 已批准变更索引

<!-- human-docs:change-index:start -->
<!-- 由 pre-commit hook 或 npm run docs:sync 生成；不要手工编辑本区块。 -->

当前 Spec：`mvp-v2` · `sha256:7e09e893af4348b0d76f0742dfe013decce455a0225a771c33c74505e914d2ea`
变更记录摘要：`sha256:42d370419b1ed6d0e087f608f699dc310a03ebc719fe4bd18393d7bd23762b75`

| 变更 | 状态 | 决策主题 |
| --- | --- | --- |
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

## 当前方向

- 仓库治理和离线发布链路已经稳定，新增功能继续走 Change Proposal → Spec → 实现 → 独立验证。
- 下一阶段按 Database → MCP → Hook/Skill → Integration 顺序实现 CHG-2026-007 目标契约，再补生产迁移/并发证明；排序算法仍须独立批准和验证。
- 历史细节需要时看 `changes/` 和 Git；活跃 `docs/` 只保留当前人类需要的信息。
