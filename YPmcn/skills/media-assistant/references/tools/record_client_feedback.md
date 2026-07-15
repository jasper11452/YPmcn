# record_client_feedback

## 何时调用

客户对当前 run 的具体提报给出反馈时调用。

## 输入

必填 `run_id`、`feedback_items`；可选 `requirement_changes`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

只按实际返回决定下一动作。

## 错误与停止条件

不得从自然语言猜测客户状态；写结果未知时先对账。
