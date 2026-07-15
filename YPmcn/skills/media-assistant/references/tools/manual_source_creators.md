# manual_source_creators

## 何时调用

需要真实人工来源补量且已有可验证结果时调用。

## 输入

必填 `demand_id`、`demand_version`；可选 `search_context`、`manual_results`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际导入结果；只把真实返回用于后续决策。

## 错误与停止条件

不得用虚拟账号、无来源数据或虚构报价补量。
