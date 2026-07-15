# search_creators

## 何时调用

已有 provider 接受的当前需求标识时调用。

## 输入

必填 `id`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际候选摘要；只有返回证据明确下游 ID 时才继续。

## 错误与停止条件

不得把旧 `requirement_id` 或推测的 candidate pool ID 代入 `id`。
