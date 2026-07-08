# record_client_feedback

## 何时调用

客户对已提报批次给出选择、拒绝、候补、需替换或需求变更反馈时调用。

## 输入

必填 `run_id`、`feedback_items`。需求变化只在用户明确表达后放入 `requirement_changes`。

## 输出成功证据

反馈写入数量、反馈汇总和 `next_action`。

## 调用后必须停在哪里

按 `next_action` 展示下一步。当前支持的 `next_action` 枚举值及对应业务路由：

| `next_action` | 含义 | 下一步动作 |
|---|---|---|
| `continue_submission` | 继续下一批提报 | 复用当前 `run_id` 调用 `create_submission_batch` |
| `rerank` | 按客户反馈重新排序 | 携带 `feedback_preferences` 重新调用 `rank_creators` |
| `requirement_change` | 客户需求变更 | 回到 `validate_requirement`，传入 `requirement_changes` |
| `close` | 关闭需求 | 流程结束，不做后续操作 |
| `manual_review` | 转人工处理 | 停止自动化流程，交由人工媒介跟进 |

未知枚举值停止并报告接入冲突。

## 禁止

不得自行解释客户反馈路由。不得在缺少 `run_id` 或真实提报记录时写反馈。不得覆盖历史运行快照。
