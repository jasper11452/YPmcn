# CHG-2026-020 Impact Analysis

```yaml
task_id: CHG-2026-020-HUMAN-IN-THE-LOOP
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
risk_level: medium
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1"
runtime_scope: "Skill interaction policy, injected system guidance, multi-platform prompt routing and local orchestration wording"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Skill / UX | 定义唯一会话输入面、允许提问条件、停止前人工决策门禁与自定义输入入口 | 不减少外发硬确认，不猜测缺失业务值。 |
| Requirement | 多平台不再把处理顺序当歧义；共享缺项一次收集 | 每个平台仍独立校验，完整原文不重写。 |
| Workflow | 确定性 `next_action` 同轮执行；`waiting_for=user` 必须落到原生弹窗或已选择暂停 | 实际 Tool 结果仍是业务事实，未知写不重试。 |
| Hook | `before_prompt_build` 注入统一 HITL 和多平台权威提示 | Host 无输出拦截能力，属于提示层约束。 |
| External send | 保留参数指纹绑定的一次性 Ask 确认 | 取消、超时、参数变化仍不外发。 |
| Provider / Database | 无变更 | 不触碰远端数据、Schema 或算法。 |

## Compatibility And Rollout

- 既有 `供给确认`、`赛后补量`、`MCN确认`、`字段确认` 和 `企微外发确认` 仍可作为原生 Ask 门禁；变化仅是禁止用普通回复替代它们。
- 历史上用户输入“继续”仍可作为恢复兼容输入，但新流程不得主动索要该词，也不得借此重新询问已确认事实。
- `select_inquiry_form_fields` 的网页 callback 是 Tool 自有交互面；Tool 返回后直接消费选择，不再追加聊天确认。
- 多平台仍按单平台 `customer_demands` 记录执行，顺序只用于确定性编排，不改变 Provider 契约。

## Verification

本地回归覆盖系统提示中的唯一输入面、禁止普通文本问题、Ask 提交同轮续接、多平台源顺序、共享缺项只问一次和不询问平台先后，以及正式 Spec 与紧凑 Skill 文档的一致性。生产 Host 尚未执行端到端复验。
