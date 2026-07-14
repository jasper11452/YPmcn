# CHG-2026-012 Impact Analysis

```yaml
task_id: CHG-2026-012
status: ANALYZED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
lane: standard-high
```

## Domain Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Business Spec / Database / MCP | No | `spec/**` 与业务组件禁止修改。 |
| Developer Tooling | Yes | 升级任务路由、调度、状态、验证和指标控制面。 |
| Claude Project Config | Yes | 仅新增仓库级设置，不修改用户全局配置。 |
| Test / Documentation | Yes | 更新控制面回归测试与项目 Agent 文档。 |
| Packaging / Production | No | 不进入插件发布包，不访问生产系统。 |

## Compatibility

- 新建任务使用 `schema_version: "2.2"`；缺少该字段的已归档任务和 Verification 保持只读兼容。
- 旧 Codex Profile 不再允许用于 V2.2 新任务，但历史证据中的模型名不重写。
- 状态首次写入 V2.2 时补齐 revision；不对历史 JSONL 进行盲目重放。

## Risks And Mitigations

| Risk | Level | Mitigation |
| --- | --- | --- |
| 五并发放大资源消耗 | High | 仅调度无路径冲突任务；状态写入串行；实际并发仍受任务池约束。 |
| 同模型 fallback 削弱独立性 | High | Critical 禁止自动 fallback；Standard-High 明确记录降级。 |
| 历史任务因 Schema 升级失效 | Medium | 兼容读取历史任务，V2.2 规则只强制新任务。 |
| Codex 越权写入 | High | 独立 Worktree、workspace sandbox、realpath/路径集合预检和冻结 diff 复核。 |
| 状态并发丢更新 | High | 原子目录锁、revision 比较、同目录原子 rename 和事件审计。 |
| 指标口径不完整 | Medium | 缺失 Provider 字段记 `null/not_observed`，不推断费用或缓存命中。 |

## Rollback

- revert 代码、契约、测试和文档提交。
- 删除该任务在 Git common dir 下的运行态和结果不会影响 Git 历史或业务数据。
- 不涉及数据库、发布、外部写或凭据迁移。

