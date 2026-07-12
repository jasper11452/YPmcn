# CHG-2026-005 Impact Analysis

```yaml
task_id: CHG-2026-005
status: ANALYZED
risk_level: medium
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Domain Impact

| Domain | Change | Evidence / Constraint |
| --- | --- | --- |
| Database | No | 不改 Schema、writer ownership、不变量或证明状态。 |
| MCP | No | 不改 Tool、输入输出、错误和副作用。 |
| Skill / Hook | No | 不改 OpenClaw Hook；这里只新增 Git 生命周期 hook。 |
| Workflow / Error | No | 不改业务阶段、转换、恢复或重试语义。 |
| Algorithm | No | 继续保持 `external-unverified`。 |
| Documentation | Yes | 正常流程改为提交前自动同步，手动命令降级为修复入口。 |
| Tooling | Yes | 新增版本化 pre-commit hook、自动安装和安全同步脚本。 |
| Test | Yes | 新增三项 Git hook 生命周期测试。 |
| Packaging | No | hook、仓库文档和治理脚本不进入插件发布包。 |

## Trigger Boundary

- 触发来源：暂存的 `spec/**` 或正式 `changes/CHG-*.md`；`-impact.md` 不独立改变生成索引。
- 自动结果：更新三个 marker 区块，并执行受限 `git add -- docs/README.md docs/PROJECT_MAP.md docs/EVOLUTION.md`。
- 非触发内容：普通实现、测试或人工说明变化不会重算 Spec 摘要。
- 验证边界：`verify:docs` 永远不写文件；hook 被禁用或绕过时仍会失败。

## Risks And Mitigations

| Risk | Level | Mitigation |
| --- | --- | --- |
| hook 把未选择的改动带入提交 | High | 相关来源或三份文档存在未暂存/未跟踪变化时立即失败，不自动扩大暂存范围。 |
| 本地 hook 未安装 | Medium | 根 `npm ci` 的 `prepare` 自动设置 `core.hooksPath`；统一验证仍检查漂移。 |
| 验证命令静默修改工作树 | Medium | `verify:docs` 保持 `--check` 只读，统一 `verify` 不调用同步模式。 |
| 常驻 watcher 产生竞态 | Medium | 明确不安装 watcher；只在原子提交边界执行。 |
| 文档成为第二份 Spec | Low | 仍只生成摘要和导航，正式判断回到根 `spec/`。 |
| 非 Git/发布安装失败 | Low | 安装脚本检测 Git 根与 hook 目录，不满足时成功跳过。 |

## Compatibility And Rollback

- 只使用 Node.js、POSIX shell 与 Git，不新增 npm 依赖。
- macOS/Linux Git 工作树启用 hook；发布包或无 `.git` 环境安全跳过。
- 回滚只需 revert hook、脚本、测试和文档，无数据迁移、生产配置或业务状态影响。

## Open Questions

无。即时保存同步不作为仓库默认能力；若未来确有实时预览需求，应以显式前台 watch 命令单独提案，不安装隐藏后台服务。
