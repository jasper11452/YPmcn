# 交互模式

用 `askuserquestion` 弹窗让用户做决策。聊天正文只写决策所需短摘要。弹窗放 1 个问题和 ≤3 个互斥选项。

## 模式速查

| 模式 | 触发时机 | 选项 |
|---|---|---|
| `requirement-draft` | validate_requirement 返回 status=draft | 用户补充信息、暂缓、放弃 |
| `confirm-structured-brief` | validate_requirement 返回 status=ready | 确认结构化和数据指标、修改需求 |
| `confirm-filter-metrics` | search_creators 后、rank_mcns 前 | 确认搜索口径、调整筛选参数 |
| `confirm-supply-ratio` | rank_mcns 成功后 | 确认 MCN/野生比例、手动增补 |
| `mcn-select-for-wechat` | 比例确认后 | 选择需发送的 MCN（编号选择） |
| `confirm-form-fields` | MCN 名单确认后 | 确认表单字段是否覆盖 brief |
| `confirm-wecom-permission` | 表单确认后 | 仅媒介/采购可发 |
| `mcn-wechat-send` | 权限通过后 | 预览并确认企微消息内容 |
| `proceed-to-ranking` | create_with_distributions 成功后 | 是否进入达人精排 |
| `confirm-medium-risk` | 中风险需要确认时 | 接受中风险继续 |
| `confirm-risky-submission` | 提报含 need_confirm 账号时 | 接受风险账号继续 |
| `status-recovery` | 恢复会话时 | 按阶段选择继续或放弃 |
| `requirement-modify` | 用户修改需求时 | 重新校验、放弃修改、强制覆盖 |
| `insufficient-supply` | 供给不足时 | 补量、放宽条件、继续 |

## 规则

- 正文一个段落说明当前结果+需要用户决策什么
- 选项中文，短，互斥
- 用户选"确认/继续" → 立即执行对应工具，不二次问
- 用户选"取消/拒绝" → 停，不自动推进
- 弹窗只做决策；hook 层做系统校验。两者独立不互替
