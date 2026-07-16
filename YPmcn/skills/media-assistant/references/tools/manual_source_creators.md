# manual_source_creators

## 何时调用

需要真实人工来源补量且已有可验证结果时调用。

## 输入

必填 `demand_id`、`demand_version`；可选 `search_context`、`manual_results`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际导入结果；只把真实返回用于后续决策。

## 能力边界

这是人工结果导入，不是浏览器搜索器或自动采集器。只有用户/媒介已经取得且可核验的来源数据才能写入；机构不足后的补量顺序仍需人工确认。
人工结果包含达人或供应商身份时，以当前 MCP 接受/返回的 `kwUid`、`supplier_id` 为准；不得自行改写为 Spec 目标模型的 `creator_id`、`supplier_binding_id`，也不得猜测映射。

## 错误与停止条件

不得用虚拟账号、无来源数据或虚构报价补量。
