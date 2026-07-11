# record_client_feedback

## 何时调用

已有 submission batch，客户对具体 submission 给出状态时调用。

## 输入

必填 `run_id`、`feedback_items`；每项必含 submission_id、status，可带 reason。

## 输出成功证据

- success === true
- data.updated_count
- data.next_action

## 调用后必须停在哪里

进入 `feedback_routing`，只按 data.next_action 决定补批、重排或需求变更。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。不得把自然语言猜测映射为客户状态，不得绕过 submission ID。
