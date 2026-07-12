# Changes

每个正式变更先在这里留下决策与影响证据，再修改 Spec 或实现。

## 命名

```text
CHG-YYYY-NNN-<slug>.md
CHG-YYYY-NNN-<slug>-impact.md
```

## 生命周期

```text
DRAFT → ANALYZED → SPEC_APPROVED → IMPLEMENTING
→ TESTING → REVIEWING → PACKAGED → RELEASED
```

涉及字段、Tool、错误码、权限、Hook 阻断、流程阶段、算法输入输出或对外行为时，Change Proposal 必须先于实现。修复内部文档错字等非契约变更仍要有明确任务边界，但可在同一份记录中简化影响分析。

已发布变更只追加结果和证据，不回写历史决策；新的决定使用新的 Change ID。
