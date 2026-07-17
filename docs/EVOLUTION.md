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

当前 Spec：`mvp-v2` · `sha256:7104cb86a097da6c5f988fd0630bbb8c6a737fe0cbdecea73a4bbdf2093127ad`
变更记录摘要：`sha256:ca3764eaf01e948f2b18a60622f8e40c899a3075644b20f46ead0410ba78a267`

| 变更 | 状态 | 决策主题 |
| --- | --- | --- |
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
