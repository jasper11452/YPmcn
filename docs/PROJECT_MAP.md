# 项目地图

## 一张图看结构

```text
业务来源 → changes/ 决策 → spec/ 契约 → 组件实现 → tests/ 验证 → packages/ 发布
                                   ├─ YPmcn/        Skill + Hook
```

| 位置 | 责任 | 人工检查重点 |
| --- | --- | --- |
| `.githooks/` | 提交前自动维护 | 只同步相关变更，不扩大部分暂存范围 |
| `spec/` | 唯一正式机器契约 | 字段、Tool、Host namespace、阶段、错误、副作用是否一致 |
| `changes/` | 为什么改、影响什么 | 范围、风险、验证、回滚是否明确 |
| `YPmcn/` | 可发布插件组件 | Skill/Hook 是否只执行契约允许的行为 |
| `tests/` | 仓库总门禁 | 是否锁定契约而不是迁就实现 |
| `scripts/` | 验证、同步、打包 | 是否确定性、无隐式安装或生产写入 |
| `docs/` | 人类说明 | 是否短、当前、只解释不复制 Spec |
| `packages/` | staging 与发布包 | 只放生成物，不放源码或第二份 Spec |
| `fix-logs/` | 故障闭环 | 根因和预防规则是否可复用 |

## 正式契约地图

<!-- human-docs:contract-map:start -->
<!-- 由 pre-commit hook 或 npm run docs:sync 生成；不要手工编辑本区块。 -->

Spec 摘要：`sha256:aa31129cb14fd922403ad43c5764af1ff98dd0f892f3bd92671e5ec8b3f20519`

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

## 去哪里改

| 变化类型 | 第一落点 | 随后检查 |
| --- | --- | --- |
| Tool、字段、返回、副作用 | `spec/mcp.json` | Skill、Hook、测试、provider 差异 |
| 阶段、等待、恢复顺序 | `spec/workflow.json` | Hook 状态投影与恢复测试 |
| 写表、不变量、幂等 | `spec/database.json` | provider/数据库外部证明 |
| canonical 需求、字典、金额/deadline、constraint/Join/late data | `spec/requirements.json` | `spec/requirement-dictionary.json`、`spec/schemas/` 与错误映射 |
| Skill 可调用范围 | `spec/skills.json` | `YPmcn/skills/` 与 Tool 卡 |
| Hook 事件和守卫 | `spec/hooks.json` | `YPmcn/src/index.ts`、`YPmcn/src/runtime-hooks.ts` 与 `YPmcn/tests/native-hooks.test.mjs` |
| 错误与重试 | `spec/errors.json` | 写结果未知时的对账路径 |
| 算法规则 | `spec/algorithms.json` | 未批准时保持阻断，不从代码反推 |
| Agent 执行边界 | `docs/AGENT_SPEC_WORKFLOW.md` | 不改业务 Spec；遵守单写者、最小验证和 Token 上限 |
| 仅内部实现或文档 | 对应组件/文档 | 仍需有界任务和验证 |

Spec 或正式 Change Proposal 提交时会自动刷新三个事实区块；`npm run docs:sync` 只是即时预览/修复入口，`npm run verify:docs` 始终只读。

## 三个不要混淆

- `YPmcn/` 是发布组件，不是第二个项目根。
- 本地测试和模拟结果不是生产 provider 证据。
- `mcp__ypmcn__<contract-tool>` 是 Host 的唯一业务工具身份；provider `tools/list` 使用 bare name，`vector-mcp` 不属于业务 provider。
- 发布包中的 `spec/` 是构建快照，不是可编辑事实源。
