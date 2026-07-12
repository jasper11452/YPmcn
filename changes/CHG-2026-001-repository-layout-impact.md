# Impact Analysis：CHG-2026-001

## Change Summary

- 变更内容：统一项目根目录、正式契约入口、流程目录和构建产物位置。
- 变更原因：当前最新产品成果停留在 worktree，正式 Spec 位于嵌套包，构建产物散落根目录，和项目流程文档不一致。
- 风险等级：Medium。业务契约语义不变，但加载路径、测试路径和打包路径会变化。

## Contract Changes

- Database Spec：内容不变，路径迁移到 `spec/database.json`。
- MCP Spec：`profiles/mvp-v2.json` 重命名为 `spec/mcp.json`；Tool 契约内容不变。
- Skill Spec：新增 `spec/skills.json`，只引用 MCP Tool，不复制其参数定义。
- Hook Spec：新增 `spec/hooks.json`，固化现有六个 Hook 事件和责任边界。
- Workflow Spec：内容不变，路径迁移到 `spec/workflow.json`。
- Error Spec：内容不变，路径迁移到 `spec/errors.json`。
- Algorithm Spec：新增显式 `external-unverified` 占位契约；在批准前阻断算法契约变更，不发明业务规则。

## Affected Files

| 路径 | 原因 | 责任域 | 本任务可修改 |
|---|---|---|---|
| `spec/**` | 建立唯一正式契约入口 | Architect | Yes |
| `YPmcn/src/contract/loader.ts` | 从仓库根或发布包读取 Spec | Skill/Hook runtime | Yes |
| `YPmcn/tests/**`、`tests/**` | 锁定新路径与契约漂移 | Tester | Yes |
| `scripts/prepare-package.mjs` | staging 和产物归位 | Packager | Yes |
| `scripts/verify.mjs` | 增加 Spec 门禁 | Tester/Packager | Yes |
| `README.md`、`AGENTS.md`、`docs/**` | 明确目录、流程和权威顺序 | Docs/Architect | Yes |
| `workflows/**` | 角色化任务与独立验证模板 | Architect | Yes |
| `doc/**` | 用户本地来源资料和 Alias | Source documents | No |
| `vector-mcp/src/**` | 与目录治理无关 | MCP | No |

## Dependency Order

1. Change Proposal / Impact Analysis
2. Spec 路径与 manifest
3. Runtime loader 和各消费者
4. Contract / package tests
5. Docs / workflow templates
6. Package
7. Independent review
8. Main integration

## Compatibility

- 对外 Tool 和数据库契约：无行为变化。
- 仓库内旧路径：属于有意的破坏性开发路径变更，所有当前消费者必须原子更新。
- 发布包路径：仍暴露 `./spec/mcp.json`，由打包 staging 生成；旧 `./spec/profiles/mvp-v2.json` 不再作为当前入口。
- 旧调用方：不受运行时 Tool 行为影响；若外部代码硬编码读取旧发布包 Spec 路径，需要升级到 3.0.0 的 manifest 声明路径。

## Validation

- Spec manifest 与领域文件存在且 profile 一致。
- Skill allowed tools 与 MCP required/optional tools完全一致。
- Hook 事件与当前注册表一致。
- 仓库不存在受版本控制的第二份正式 Spec。
- 插件测试、根契约测试、向量 MCP 测试、密钥扫描和 package dry-run 全部通过。
- 独立 Verifier 输出 `PASS / FAIL + evidence`。

## Rollback

- 通过单独提交保持路径迁移可整体 revert。
- 不删除任何未合并分支或用户未提交文件。
- 打包 staging 与 release 目录均为忽略产物，可安全删除后重建。

## Open Questions

- 无阻塞问题。JSON 扩展名是本项目已验证的机器契约格式；流程文档中的 YAML 是格式示例，不创建双份 YAML 镜像。

