# 交互模式

用 `askuserquestion` 弹窗让用户做决策。聊天正文只写决策所需短摘要。弹窗放 1 个问题和 ≤3 个互斥选项。

## 模式速查

| 模式 | 触发时机 | 选项 |
|---|---|---|
| `requirement-draft` | validate_requirement 返回 status=draft | 用户补充信息、暂缓、放弃 |
| `confirm-medium-risk` | 中风险需要确认时 | 接受中风险继续 |
| `mcn-wechat-send` | 企微消息确认后 | 确认发送、取消发送 |
| `confirm-ranking-after-supply-ready` | 机构回填和达人拓展结果回收到候选池后 | 确认对候选池进行达人精排 |
| `confirm-risky-submission` | 提报含 need_confirm 账号时 | 接受风险账号继续 |
| `status-recovery` | 恢复会话时 | 按阶段选择继续或放弃 |
| `requirement-modify` | 用户修改需求时 | 重新校验、放弃修改、强制覆盖 |
| `insufficient-supply` | 供给不足时 | 补量、放宽条件、继续 |

## 规则

- 正文一个段落说明当前结果+需要用户决策什么
- 选项中文，短，互斥
- 不要在 `validate_requirement` 调用前弹窗确认；Brief 入口先解析并调用工具
- 用户选"确认/继续" → 立即执行对应工具，不二次问
- 用户选"取消/拒绝" → 停，不自动推进
- 弹窗只做决策；hook 层做系统校验。两者独立不互替
