# CHG-2026-015 Impact Analysis

```yaml
task_id: CHG-2026-015-MANUAL-SOURCING
status: IMPLEMENTED_LOCAL_PROVIDER_BLOCKED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
runtime_scope: "local plugin, packaged Skill, target MCP contract"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| MCP input | `manual_source_creators` 新增必填正整数 `target_count` | Provider 未部署新输入前不得启用新版真实调用。 |
| MCP output evidence | 增加任务证据字段的目标成功结构 | 仍标记为 Provider 未广告；Hook 必须逐字段验证，不能把普通 envelope 当启动证据。 |
| Workflow | 高风险供给增加手扒、仅 MCN、调整数量三条分支 | 供给确认与企微外发确认完全分离。 |
| Hook state | 保存风险、缺口、建议数量及脱敏任务投影 | 本地状态不是 Provider 任务事实，不向用户展示内部任务 ID。 |
| Skill / Prompt | 改为启动或复用手扒任务，并要求同轮继续 MCN | 禁止回退到硬缺口 `0` 或旧的一字段调用。 |
| Tests / package | 增加输入校验、Ask 回放、任务证据和发布包断言 | 不调用生产写 Tool。 |
| Database / Provider | 记录当前仓库没有可证明任务启动的已观测表或实现 | 任务持久化、幂等、执行器、硬筛和入池必须在 Provider 仓库另行实现和验证。 |
| Errors / Algorithm | 本次不新增错误码、不定义风险算法 | 使用现有 `INVALID_INPUT`、`STATE_CONFLICT`、`WRITE_RESULT_UNKNOWN`；风险和补量由 Provider 返回。 |

## Compatibility And Rollout

- 这是 `manual_source_creators` 的必填输入变更，旧 Provider 会拒绝 `target_count` 或仍只接受一字段，因此发布顺序必须是 Provider 先行、插件后行。
- Provider 可在灰度期间兼容旧调用，但新版正式语义下缺少 `target_count` 必须拒绝，避免隐式补量。
- output schema 未由远端 `tools/list` 广告；Hook 的严格证据检查是客户端继续条件，不构成已验证的生产 Provider 能力。
- 回滚插件不删除或重启任何已经创建的远程任务。

## Security And Data

- Agent 只发送需求 ID 和用户确认的数量，不发送搜索上下文、风险推断、人工结果、操作人或平台字段。
- Hook 事件只保存任务 ID、状态、数量、操作和时间等最小投影，不保存客户 Brief、手扒原始数据或候选明细。
- 未知写结果禁止盲重试；必须通过 Provider 权威状态对账。
- 企微外发仍经过独立参数指纹确认，不复用供给确认。

## Verification

本地先运行插件契约与 Hook 回放，再运行仓库完整离线门禁、包生成和归档内容检查。生产可用性还必须在 Provider 仓库通过任务幂等/持久化测试、只读 `tools/list` 对齐和隔离 Live E2E；这些结果不能由本仓库伪造。

2026-07-20 的只读 Provider 检查实际失败：远端 `manual_source_creators` 缺少必填 `target_count` 及其属性定义，仍是一字段契约。因此该失败是明确的发布阻断，不是可忽略的测试环境告警。
