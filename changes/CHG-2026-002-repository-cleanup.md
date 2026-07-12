# CHG-2026-002：退役旧链路并清理仓库

```yaml
task_id: CHG-2026-002
change_type: maintenance-security
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 审阅清单后明确批准删除"
baseline: "main@a6b93cf"
rollback_strategy: "tracked 文件通过 revert 恢复；生成物重新安装或构建；已批准删除的未跟踪本地文件不保留副本"
```

## Decision

1. 退役根目录中仍可连接真实数据库、后端或企微的旧 `2.1.x` MockMCP 链路，生产集成只服从 `spec/` 与远端 provider 边界。
2. 删除无运行时消费者的重复企微模块、假向量索引构建器及其过时操作文档。
3. 从仓库移除完整客户需求 CSV。正式 Spec、测试和文档不得保存完整 Brief 或 payload。
4. `doc/` 只暂留 `spec/algorithms.json` 明确引用的算法来源 Alias；其余不可移植且无引用的 Finder Alias 删除。
5. 历史计划、草稿需求、旧数据库快照和重构前架构图不继续占用活跃文档树；批准决策只保留在 `changes/`，当前说明保留在 `docs/`。
6. 删除可重建依赖、构建物、工具缓存、旧 tgz 和已废弃分支；保留当前 `3.0.0` 发布包与 `archive/portable-plugin-core-20260712`。
7. 本变更不修改任何正式 Spec、Tool Schema、Hook 语义、数据库或生产 provider。

## Scope

### Included

- 删除旧 MockMCP、直接企微发送模块、手工发送脚本和假向量索引脚本。
- 将安全测试从“旧 Mock 必须缺凭据失败”改为“旧 Mock 与重复发送模块不得存在”。
- 删除被新实现或正式流程取代的文档与草稿。
- 删除完整客户需求 CSV 和七个无引用 Finder Alias。
- 保留根 `src/` 的最小职责说明，避免目录含义再次漂移。
- 验证后删除本地缓存、构建物、依赖、历史发布包和旧 Git 分支。

### Excluded

- 不修改 `spec/**`。
- 不修改 `reference-mcp/**`、`vector-mcp/src/**` 或当前 `YPmcn` TypeScript 契约/Hook。
- 不访问生产数据库、provider 或企微，不执行生产写操作。
- 不删除 `packages/releases/ypmcn-media-assistant-3.0.0.tgz`。
- 不删除 `archive/portable-plugin-core-20260712`。
- 不清理 Git 历史对象；若未来配置 remote，再单独决定是否做历史净化。

## Task Boundary

```yaml
goal: "移除与 mvp-v2 权威链路冲突的旧实现、敏感来源资料、历史噪声和可重建产物"
allowed_paths:
  - "changes/CHG-2026-002-*"
  - "README.md"
  - "src/**"
  - "tests/**"
  - "mock-mcp.mjs"
  - "scripts/build-vector-index.mjs"
  - "scripts/test-wecom-send.mjs"
  - "YPmcn/src/send_wecom.mjs"
  - "docs/db-schema-diff-and-migration.md"
  - "docs/integration-readiness.md"
  - "docs/rag-vector-integration-guide.md"
  - "docs/wecom-send-mcp-dev-guide.md"
  - "docs/requirements/**"
  - "docs/superpowers/**"
  - "docs/diagrams/**"
  - "doc/**"
  - "ignored generated files and local Git refs"
forbidden_paths:
  - "spec/**"
  - "reference-mcp/**"
  - "vector-mcp/src/**"
  - "YPmcn/src/contract/**"
  - "YPmcn/src/hooks/**"
  - "YPmcn/skills/**"
  - "packages/releases/ypmcn-media-assistant-3.0.0.tgz"
  - ".env*"
acceptance:
  - "旧 MockMCP、直接企微发送模块和假向量脚本全部不存在且无活跃引用"
  - "tracked 文件不含完整客户需求 CSV；doc 只保留算法来源 Alias"
  - "活跃 docs 不含 superpowers 历史计划、draft requirements 或旧数据库迁移快照"
  - "正式 Spec 和当前产品组件内容不变"
  - "npm run verify 与 npm run pack:yp 通过"
  - "最终无 packages/.staging、node_modules、dist、工具缓存和历史 tgz"
  - "最终仅 main worktree；旧分支删除，portable archive 保留"
verification:
  - "npm run verify"
  - "npm run pack:yp"
  - "node scripts/scan-secrets.mjs --tracked"
  - "rg legacy path and MockMCP references"
  - "git diff --check"
  - "OpenCode read-only verification"
```

## Migration Order

1. 提交本 Change Proposal 与 Impact Analysis。
2. 先改安全回归测试，再删除旧实现链。
3. 删除敏感来源资料、历史文档和过时图。
4. 更新根目录说明并运行全量离线验证。
5. 重新打包并由不同模型只读验证冻结差异。
6. 快进 `main`，再删除 ignored 生成物、临时 worktree 和旧分支。

## Rollback

- tracked 文件和测试通过 revert 本变更提交恢复。
- `node_modules`、`dist` 和发布包可通过 `npm ci`、`npm run verify`、`npm run pack:yp` 重建。
- 五个已修改 Finder Alias 与未跟踪 draw.io 图由用户明确批准删除，不在仓库中复制或备份。
- 客户原始需求不应重新写回 Git；若业务仍需访问，应从受控外部资料库读取。
