# Fix Logs

重要故障修复后在这里记录可复用经验。Fix Log 解释“为什么出错、怎样证明已修复”，不取代 Change Proposal、Spec 或测试。

建议命名：`YYYY-MM-DD-<slug>.md`。

```md
# 问题标题

## Symptom
- 用户可见现象：
- 首次发现时间：

## Root Cause
- 直接原因：
- 契约或门禁为何未提前发现：

## Fix
- 最小修复：
- 关联 Change ID：

## Verification
- 复现测试：
- 回归命令：

## Prevention
- 新增的 Spec、测试或流程门禁：
```
