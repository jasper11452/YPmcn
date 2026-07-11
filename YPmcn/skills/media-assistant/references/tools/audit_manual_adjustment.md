# audit_manual_adjustment

## 何时调用

媒介明确移除、替换、强制加入或重排达人，需要留下可审计前后排名时调用。

## 输入

必填 `run_id`、`adjustments`、`operator_id`。每项 action、目标、原因和 before/after rank 按 schema 传。

## 输出成功证据

- success === true
- data.audit_id
- data.items
- data.written_count

## 调用后必须停在哪里

展示已记录数量；如调整改变推荐结果，重新查询 run 详情再决定提报。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。缺操作者、原因或前后证据时不得写审计。
