# CHG-2026-010 Impact Analysis

```yaml
task_id: CHG-2026-010-REF-MCP
status: ANALYZED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Reference outputs | Yes | 15 工具严格匹配冻结 Schema。 |
| Workflow simulation | Yes | 服务端权威状态、版本、动作与恢复幂等。 |
| Requirement validation | Yes | 只实现已批准的数据有效性，不推断排名算法。 |
| Late data / promotion | Boundary only | 保持冻结 artifact，不凭缺失输入伪造 promotion。 |
| Production | No | 无网络、无数据库、无 provider 写。 |

## Data And Security

- 不返回、日志或持久化 raw customer messages；只保留 canonical digest/脱敏模拟身份。
- 不添加未批准 MCP 输入字段。
- simulation 标记不污染 `additionalProperties: false` 的业务数据。

## Risks

- MCP 公开输入不足以完整模拟 multi-platform splitting、late-data cutoff 和 offer promotion；本任务只 fail closed 并记录边界。
- utility writes 不在 workflow allowed-actions 列表中；不得通过改 Spec 或本地推断添加 transition。
- 模拟器通过不代表生产数据库 CAS、唯一键、cron 或 provider 相关性已部署。

## Verification

聚焦 Reference MCP、provider comparator、全量仓库门禁、secret scan 与 diff check；OpenCode 冻结 SHA 只读复验。
