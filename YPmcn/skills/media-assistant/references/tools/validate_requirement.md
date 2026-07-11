# validate_requirement

## 何时调用

新 Brief、需求补充或需求变更进入链路时调用，是第一条业务写工具。

## 输入

没有固定 required 字段，但必须命中 raw 或 structured 模式至少一种。raw 使用 `raw_messages`/`raw_messages_json`；structured 只使用 profile 声明字段。金额用分、返点用小数、时间带时区。

## 输出成功证据

- success === true
- data.id
- data.status

只有 status 为 ready 时，才把 data.id 记录为 requirement_id。

## 调用后必须停在哪里

draft 停在缺项补充；ready 进入 `requirement_ready`，再调用 `search_creators`。

## 错误与停止条件

原文不足、字段冲突、schema 不兼容时停止。不得编造平台、数量、预算、返点或截止时间。
