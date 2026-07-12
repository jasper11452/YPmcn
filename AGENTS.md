# AGENTS.md

## 项目入口

- Git 根目录是唯一长期项目；相邻 worktree 仅用于单任务隔离。
- `YPmcn/` 是可发布插件组件，不是另一个项目根。
- 人类先读 `docs/README.md`、`docs/PROJECT_MAP.md`、`docs/EVOLUTION.md`；它们只解释和导航，不替代 Spec。
- 完整执行规范见 `docs/AGENT_SPEC_WORKFLOW.md`；开发流程见 `docs/DEVELOPER_SPEC_WORKFLOW.md`。

## 权威顺序

```text
安全与数据完整性
> spec/manifest.json 指向的已批准 Spec
> changes/ 中已批准的 Change Proposal
> 测试与验证规则
> 当前实现
> Agent 推断
```

- MCP Tool 唯一权威：`spec/mcp.json`。
- 阶段和恢复唯一权威：`spec/workflow.json`。
- 数据库写归属：`spec/database.json`；Hook 或 Skill 不得虚构部署完成。
- 错误和重试：`spec/errors.json`；写结果未知时先对账，不盲目重写。
- Skill 与 Hook 边界：`spec/skills.json`、`spec/hooks.json`。
- Algorithm 仍为 `external-unverified`；不得从当前代码反推正式规则。

Spec 缺失、冲突或未批准时输出 `BLOCKED`，不得自行设计公开契约。

## 变更门禁

任何生产实现前必须存在：Task ID、Change Proposal、Impact Analysis、关联 Spec/版本、允许与禁止路径、验收标准、验证命令和回滚方式。契约变化先改 Spec，再按 Database → MCP → Hook → Skill → Test → Package 的依赖顺序实施。

Spec 或正式 Change Proposal 必须完整暂存；pre-commit hook 会自动同步并暂存三份人类文档。Agent 无需把 `npm run docs:sync` 当固定步骤，但完成前仍须人工复核叙事并运行只读 `npm run verify:docs`。部分暂存时 hook 必须 fail closed。

- 只修改任务拥有的文件，不顺手重构或弱化测试。
- Bug 修复先添加稳定失败测试，再做最小修复。
- 不直接在 `main` 实施；并行写任务使用独立分支和 worktree。
- 合并或归档后确认 worktree clean、提交已保留，再移除临时目录。
- 不编辑生成的 `dist/`、`packages/.staging/` 或 tgz 作为源码。
- 不记录 Brief、完整 payload、凭据或未脱敏内部状态。
- Python 始终使用 `uv`，禁止 pip。

## 三工具职责

- Claude Code：Orchestrator，只产出目标、文件边界、验收、验证和回滚。
- Codex：主 Executor，在独立 worktree 内实施、自测并提交 `diff + test results + known risks`。
- OpenCode：不同模型/上下文的只读 Verifier，基于冻结 SHA 输出 `PASS / FAIL / BLOCKED + evidence`。

不要让同一推理链自证正确；Verifier 默认不修改生产代码。

## 项目安全边界

- 下游只用 `requirement_id`、`candidate_pool_id`、`mcn_recommendation_id`、`run_id` 等明确语义 ID。
- provider Tool/Schema 与 `mvp-v2` 不一致时返回 `integration_required`，不自动降级 legacy。
- `reference-mcp/` 的 `simulated=true` 永远不是生产证据。
- 生产 provider 检查只允许 initialize、initialized notification、tools/list，不调用业务写工具。

## 验证入口

- Spec 门禁：`npm run verify:spec`。
- 人类文档同步：提交前自动；即时预览/修复：`npm run docs:sync`；只读门禁：`npm run verify:docs`。
- 仓库离线验收：`npm run verify`。
- 发布包：`npm run pack:yp`，产物只能进入 `packages/releases/`。
- 生产 provider 独立只读门禁：`npm run verify:provider`。

生产门禁失败不得通过降低 Schema 检查、恢复 Mock 成功或跳过测试消除。
