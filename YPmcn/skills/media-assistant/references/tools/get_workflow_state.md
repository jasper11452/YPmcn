# get_workflow_state

## 何时调用

需要只读核对需求版本、trace 对应流程事实，或写结果未知需要先对账时调用。

## 输入

二选一：传 `demand_id` 与 `demand_version`；或只传 `trace_id`。不得混用无关需求版本和 trace。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

查询不推进主链。只展示实际状态，并据此判断是否安全恢复、重试或返回 `integration_required`。

## 能力边界

它查询 Provider 工作流事实，不证明此前业务动作成功，也不能用本地 Hook phase、健康检查或推测状态替代返回结果。

## 错误与停止条件

缺少完整的 `demand_id` + `demand_version` 且也没有 `trace_id` 时停止。查询不到、版本冲突或结果含糊时不得补造状态。
