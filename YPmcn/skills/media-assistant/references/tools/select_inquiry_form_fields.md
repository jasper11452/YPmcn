# select_inquiry_form_fields

## 何时调用

MCN 方案和外发消息已确认，需要确定询价列时调用。字段选择是发送前最后确认点。

## 输入

无必填字段；可选 `url`、`timeout_seconds`。

## 输出成功证据

- provider description advertises description string in 数据库字段名：字段备注 format
- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

向用户展示 description 中的字段与备注，确认后才组装 `columns`。

## 能力边界

该工具只负责字段选择，不发送消息、不创建项目，也不证明企微模板、供应商权限或回执链路可用。

## 错误与停止条件

不得要求旧 `mcn_recommendation_id`，不得声称返回 `fields`、`items` 或 count。
