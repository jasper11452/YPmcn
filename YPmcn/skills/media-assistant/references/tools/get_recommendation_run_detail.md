# get_recommendation_run_detail

## 何时调用

恢复或核对推荐运行、提报和反馈事实时只读调用。

## 输入

必填 `run_id`。

## 输出成功证据

- success === true
- data.run_id
- data.recommendation_snapshot

## 调用后必须停在哪里

查询本身不推进 phase；根据权威快照决定下一安全动作。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。查询不到时报告未知，不补造历史状态。
