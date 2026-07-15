# validate_requirement

## 何时调用

新 Brief、补充或变更进入链路时调用。

## 输入

必填 `payload`，完整结构按当前 schema 传入。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

只依据实际返回判断能否继续；缺需求 ID 或状态证据时停止。

## 错误与停止条件

不得编造需求字段。写结果未知时先对账，不盲目重试。
