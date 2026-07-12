# YPmcn

这是 YPmcn 的唯一长期项目仓库。日常开发、Spec、验证与发布都从 Git 根目录开始；相邻的 `YPmcn-worktrees` 只用于单任务隔离，任务完成后清理，不是第二个项目。

仓库把业务来源资料固化为可验证的 `mvp-v2` 契约、OpenClaw Skill/Hook、无网络 reference MCP、向量 MCP 和只读 provider 预检。

## 人类阅读入口

- [1 分钟总览](docs/README.md)：项目是什么、当前能不能上线、先读什么。
- [项目地图](docs/PROJECT_MAP.md)：每个目录负责什么、不同变更去哪里改。
- [演进历程](docs/EVOLUTION.md)：为什么从旧 Mock/多入口演进到当前结构。

这三份文档用于理解和导航；正式契约仍只在根 `spec/`。
`spec/**` 或正式 Change Proposal 提交时，版本化 pre-commit hook 会自动同步机器事实；正常流程不需要手动维护生成区块。

## 目录

```text
project/
├── .githooks/     # 提交前自动同步与安全检查
├── spec/          # 唯一已批准机器契约
├── changes/       # Change Proposal、Impact Analysis、决策记录
├── src/           # 根级共享代码边界（当前无独立运行时）
├── tests/         # 仓库级契约、集成和发布测试
├── workflows/     # 跨 Session 任务、Profile、状态契约和验证证据
├── packages/      # staging 与 tgz 产物，不含源码
├── docs/          # 使用、设计和流程文档
├── fix-logs/      # 重要故障根因与预防经验
├── YPmcn/         # 可发布 OpenClaw 插件组件
├── vector-mcp/    # 创作者向量检索 MCP
└── reference-mcp/ # 完全离线、simulated=true 的演练 MCP
```

`YPmcn/` 是 npm 发布组件，不是嵌套 Git 项目。当前生产代码分别归属 `YPmcn/` 与 `vector-mcp/`；根 `src/` 不维护重复实现。

`doc/` 只暂留 `spec/algorithms.json` 引用的算法来源 Alias，不是正式机器契约。完整客户 Brief、payload 和不可移植的本地资料不进入 Git。

## Spec 是唯一事实源

先读 `spec/manifest.json`。当前正式契约为：

- `spec/mcp.json`：Tool、输入输出、错误和副作用。
- `spec/database.json`：数据库不变量、writer ownership 和外部证明边界。
- `spec/hooks.json`、`spec/skills.json`：Hook/Skill 职责、允许调用和前置条件。
- `spec/workflow.json`、`spec/errors.json`：阶段、恢复、错误与重试语义。
- `spec/algorithms.json`：当前为 `external-unverified`；批准前禁止从实现推断算法规则。

优先级固定为：安全与数据完整性 > 已批准 Spec > Change Proposal > 测试 > 当前实现 > Agent 推断。契约变更必须先在 `changes/` 完成提案与影响分析。

## 当前生产状态

- 仓库目标：`mvp-v2`，语义 ID、字段选择、发送门禁和 `sync → ingest → sync` 恢复链已固化。
- 生产 provider 仍检测为 `legacy-1.9.4`，缺 `select_inquiry_form_fields`、`create_with_distributions`、`sync_mcn_inquiry_status`。
- 完整生产链路保持 `integration_required`；不自动回退旧参数，不把 reference MCP 结果当生产证据。

## 开发与验证

```bash
npm ci
npm run verify
npm run pack:yp
```

根 `package.json` 统一管理 `YPmcn` 与 `vector-mcp` 两个 npm workspace；一次根 `npm ci` 会安装全部构建和测试依赖，并自动启用仓库 hook，无需分别进入组件安装。`npm run docs:sync` 只在需要提交前即时预览或修复时使用。

`npm run verify` 执行 Spec 漂移门禁、Agent 控制面、根安装图检查、密钥扫描、插件契约与 Hook、reference MCP、文档、向量 MCP 和发布包验证。`npm run pack:yp` 在 `packages/.staging/` 组装，并把扫描后的包输出到 `packages/releases/`。

多 Agent 开发固定为 Claude Code 编排、最多两个 Codex 独立 worktree 执行、OpenCode 不同模型只读验证，再由 Claude 串行集成。任务和 Profile 在 `workflows/`，跨 Session 状态在 Git common dir；基础入口：

```bash
npm run agent-flow -- status --json
npm run agent-flow -- plan --json
npm run verify:agent-flow
```

三档 Codex 配置均为 opt-in、`fast` 且 fail closed；控制器不会修改现有默认 Profile，也不会把 YPmcn 的角色规则扩散到其他仓库。完整用法见 `workflows/README.md`。

生产 provider 只读门禁单独执行：

```bash
npm run verify:provider
```

当前该命令预期非零退出；这是上线阻塞证据，不是离线仓库测试失败。

Agent 执行规则见 `docs/AGENT_SPEC_WORKFLOW.md`，开发者流程见 `docs/DEVELOPER_SPEC_WORKFLOW.md`。插件不内置 provider 凭据、不记录客户 Brief 或完整 payload；reference MCP 不联网、不写生产数据库、不发送企微。
