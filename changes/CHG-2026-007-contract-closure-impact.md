# CHG-2026-007 Impact Analysis

```yaml
task_id: CHG-2026-007-CONTRACT
status: ANALYZED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Requirements / Schema | Yes | 新增无客户内容字典、实例 Schema 与业务有效性规则；不导入真实 Brief 或 payload。 |
| Database | Yes | 声明目标实体、关系、字段和物理唯一键；全部部署证据仍为 `external-unverified`。 |
| MCP | Yes | 为当前 15 个工具补齐输出契约；不调用 provider，不声称线上兼容。 |
| Workflow | Yes | 恢复改为服务端权威的 refresh/request/finalize 与显式状态组合；Hook session 不是授权源。 |
| Errors | Yes | 增加 fail-closed 错误码并锁定 retry/reconciliation 语义。 |
| Hook / Skill runtime | No | 本任务禁止修改；后续任务实现新契约。 |
| Algorithm | No | 排序、召回、权重和打分继续 `external-unverified`。 |
| Provider / Database deployment | No | 不连接生产、不迁移、不发布。 |
| Packaging / CI | No | 不改生成包、发布目录或流水线。 |

## Data And Security

- 字典只允许字段定义、类型、单位和枚举，不允许客户消息、Brief、payload、凭据或内部未脱敏状态。
- `raw_messages_json` 只声明规范化形式和 hash 规则；测试使用合成值，不提交真实客户内容。
- 风险与反馈采用 append-only 审计实体；不允许覆盖原决策事实。
- 迟到数据保留 lineage，但不能反向修改已冻结 snapshot、selection 或 recommendation run。

## Compatibility

- `mvp-v2` 目标契约新增要求，当前生产 provider 仍应返回 `INTEGRATION_REQUIRED` / `SCHEMA_MISMATCH`，不得降级 legacy。
- 字段选择成功返回仍使用既有 top-level envelope；服务端持久化 selection result，并由发送结果返回 selection/send 身份，其他工具继续使用 standard envelope。
- 现有 Hook session 状态可作为本地 deny-only 防线，但服务端授权只来自持久化 state version 与 `allowed_actions`。
- JSON Schema 是生成/校验输入，不是数据库 Migration 或运行时部署证明。

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| 把数据有效性规则误当排名算法 | `requirements.json` 显式限制范围，并继续引用 `algorithms.json` 的 `external-unverified`。 |
| 字典 hash 漂移或夹带客户内容 | loader 复算 hash，治理测试扫描禁止字段与 marker。 |
| 状态矩阵遗漏组合导致 fail-open | workflow 列出 closed-world combinations；未列组合映射 `STATE_COMBINATION_INVALID`。 |
| 输出契约与工具集合漂移 | loader 和测试要求 output contract key 与 required+optional tool 精确一致。 |
| 新数据模型被误报为已部署 | 每个 physical constraint 都保持 `external-unverified`，文档继续 NO-GO。 |
| Contract-only 与运行时暂时不一致 | Change 明确后续依赖顺序；禁止将当前 Hook/reference MCP 作为实现证据。 |

## Verification

- `npm run verify:spec`
- `npm run verify:docs`
- `npm run verify`
- `node scripts/scan-secrets.mjs --tracked`
- `git diff --check`
- OpenCode 以不同模型对冻结 SHA 做只读复验，并确认 Git/plan 目录无写入。

## Rollback

revert 契约提交。没有生产连接、数据库写入、Migration、包发布或凭据副作用。

## Open Questions

无阻塞问题。provider、数据库、Hook/Skill 和算法实现分别进入后续获批任务；当前结论保持 NO-GO。
