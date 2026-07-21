# CHG-2026-018 Impact Analysis

```yaml
task_id: CHG-2026-018-FRESH-MANUAL-REQUIREMENT
status: IMPLEMENTED_LOCAL_PROVIDER_UNVERIFIED
risk_level: medium
approved_spec_version: "mvp-v2 / schemaVersion 1"
runtime_scope: "local contract, packaged Skill, prompt, one-time Hook receipt and local orchestration projection"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| MCP | 输入字段不变，补充 `requirement_id` 的当次解析来源语义 | 仍只传 `requirement_id` 与正整数十进制字符串 `size`。 |
| Workflow | 手扒可从任意既有阶段重新进入需求解析，不再依赖搜索、赛马或字段选择完成 | `validate_requirement` 必须紧邻手扒，成功返回的新 ID 只能使用一次。 |
| Skill / Prompt | 删除复用旧需求 ID 与字段选择作为手扒前置的指令 | 导出仍需字段选择，但它必须发生在本次需求解析之前。 |
| Hook state | 保存并一次性消费当前解析结果的需求 ID 哈希 | 不保存原始 Brief，不查询历史库，不据此声称 Provider 成功。 |
| Tests | 锁定无解析、ID 错配、重复使用、业务调用间隔与正常放行 | 不调用生产写 Tool。 |
| Release | 补丁版本更新为 `3.4.6` 并重新打包 | 全部清单、锁文件与包内容使用同一版本。 |

## Compatibility And Rollout

- `manual_source_creators(requirement_id,size)` 的 Provider 输入形状不变；变化仅在 Agent 编排和本地调用前门禁。
- 复用已有需求 ID 的手扒调用将被拒绝，调用方必须重新提交同一需求语义并取得新的解析结果 ID。
- 生产 Provider 若不为每次 `validate_requirement` 创建新 ID，将无法满足本契约，必须先修正 Provider；本地 Hook 不尝试查询历史库补证。
- 既有手扒、排序或导出写入不回放、不删除，未知结果仍按原规则对账。

## Verification

本地一次性 ID 守卫覆盖无解析、ID 错配、重复使用、其他业务 Tool 插入以及从既有后期 phase 重新解析后放行；66 项插件测试、完整仓库门禁、Skill 结构校验、差异检查、包安全扫描和包内规则核对均通过。发布包为 `ypmcn-media-assistant-3.4.6.tgz`，SHA-256 为 `07cf8fb117817246e39171ba622c9367fdb80393098d4002d316a88704a581a2`。Provider 的每次解析全局唯一 ID 语义仍需隔离 Live E2E 证明，未用本地 Hook 冒充该证据。
