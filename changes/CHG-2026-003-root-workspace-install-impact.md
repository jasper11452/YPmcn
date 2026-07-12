# CHG-2026-003 Impact Analysis

```yaml
task_id: CHG-2026-003
status: ANALYZED
risk_level: low
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Domain Impact

| Domain | Change | Evidence / Constraint |
| --- | --- | --- |
| Database | No | 不改 Schema、Migration、writer ownership 或生产数据。 |
| MCP | No | 不改 Tool 名称、输入输出、错误或副作用。 |
| Skill | No | 不改 Skill 路由、Prompt、Tool allowlist 或前置条件。 |
| Hook | No | 不改事件、守卫、状态投影或阻断行为。 |
| Workflow | No | 不改业务阶段、转换或恢复链。 |
| Error | No | 不改业务错误码与重试语义。 |
| Algorithm | No | 保持 `external-unverified`，不推断或实现正式算法。 |
| Packaging | Yes | 根 npm 安装图覆盖两个既有可构建组件；发布包内容规则不变。 |
| Test | Yes | 新增根 workspace/lock 回归门禁，并纳入 `npm run verify`。 |
| Documentation | Yes | 明确根安装覆盖组件，不再要求隐藏的手工子目录安装步骤。 |

测试清单断言 `tests/test_skill_package.py` 随统一门禁总数从 172 更新为 173；它只校验文档证据，不改变 Skill 行为。

## Compatibility And Dependency Order

- 使用 npm 原生 workspace，兼容现有 `package-lock.json` v3 和当前 npm CLI。
- 组件包名不同，工作区路径固定，不存在命名冲突。
- 根锁文件由三个既有 manifest 生成；组件 manifest 与组件锁文件不修改。
- 先更新安装图，再运行构建、测试与打包；不改变运行时加载路径或发布包结构。
- CI 当前执行根 `npm ci` 与 `npm run verify`，因此修复与现有 CI 意图一致。

## Risks And Mitigations

| Risk | Level | Mitigation |
| --- | --- | --- |
| 根锁文件扩大会增加依赖更新审查面 | Low | 仅通过 npm 锁文件生成器更新；回归测试校验 workspace 与组件 manifest。 |
| npm hoisting 改变依赖物理位置 | Low | 构建只通过 npm scripts 解析可执行文件；从空依赖状态运行完整验证与打包。 |
| 根锁与组件锁未来漂移 | Low | 测试比较根 workspace 条目与组件 manifest 的 dependencies/devDependencies。 |
| 验证脚本隐式联网 | Avoided | `verify.mjs` 不安装依赖；联网仅发生在显式 `npm ci`。 |
| 发布包意外包含 workspace 元数据或源码 | Low | 复跑现有 package contents、密钥扫描和 `npm run pack:yp` 门禁。 |

## Migration And Rollback

- 无数据库、配置、凭据或生产 Migration。
- 开发者首次拉取后重新执行根 `npm ci` 即采用新安装图。
- 回滚只需 revert 根 manifest/lock、测试和文档变更；ignored 安装产物可直接重建。

## Open Questions

无。生产 provider、数据库证明、凭据轮换和 Git remote 配置保持为独立后续任务。
