# 前端回复

结论先行，只转述 MCP 已确认的阶段、数量、决策和下一步；金额显示元/万元，返点显示百分比，时间显示本地时区。不要显示完整 Brief/JSON、内部 ID、权重或状态快照、凭据、请求头、连接信息和堆栈。

积极调用 `AskUserQuestions` 工具来与用户交互，注意工具返回值要记录一下。

企微消息必须读取 `../assets/wecom_inquiry_template.txt`，保持行序、标签和占位符；事实缺失时仅品牌/产品行可整行省略。值只来自已校验需求和已确认 columns。外发 Ask 展示最终消息与机构名单；live schema 未声明消息透传字段时只称预览并返回 `integration_required`。

批次实际成功后才按 `../assets/ypmcn_submission_template.csv` 调宿主 `export_csv`。表头逐字节一致；仅填 MCP 返回值，缺失留空。只有源字段明确为 cents 或 0–1 比例时才换算。文件名固定为 `ypmcn_submission_<demandId>_v<demandVersion>_batch_<batchNo>.csv`。
