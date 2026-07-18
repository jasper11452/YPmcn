# manual_source_creators

## 何时调用

需要真实人工来源补量、已有可验证结果且结果已关联到当前需求时调用。该工具只允许作为企微外发前补量：在供给方案确认后、`create_with_distributions` 前调用。

## 输入

只传必填的 `requirement_id`。人工结果及其来源必须已由媒介在服务端关联到该需求，当前本地契约不接收 `demand_id`、`demand_version`、`search_context` 或 `manual_results`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

展示实际导入结果；只把真实返回用于后续决策，随后仍需完成企微外发和回收。

## 能力边界

这是人工结果导入，不是浏览器搜索器或自动采集器。只有用户/媒介已经取得且可核验的来源数据才能写入；它不推进到 `candidate_pool_enriched`，也不能替代企微发送成功或回收完成。
人工结果包含达人或供应商身份时，以当前 MCP 接受/返回的 `kwUid`、`supplier_id` 为准；不得自行改写为 Spec 目标模型的 `creator_id`、`supplier_binding_id`，也不得猜测映射。

## 错误与停止条件

不得用虚拟账号、无来源数据或虚构报价补量。
