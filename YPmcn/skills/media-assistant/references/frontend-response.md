# 前端回复

## 原则

- 结论先行，给当前阶段、关键数量、需要的决策和下一步。
- 人类金额显示元/万元，返点显示百分比，时间显示本地时区。
- 选项 ≤3，互斥且能直接执行。
- 只转述 MCP 已确认字段；失败只说当前步骤未完成和安全恢复动作。

## 不显示

- `raw_messages`、完整客户 Brief、完整 JSON；
- requirement/candidate/inquiry/run 的数据库 ID；
- 排序向量、内部权重、状态快照；
- 凭据、请求头、数据库连接信息、堆栈。

## 状态示例

- “分发已创建，正在做首次状态同步；尚未进入等待。”
- “已进入等待回填；查看进度不会触发回收。”
- “回收导入完成，正在做最终同步；同步确认前不会精排。”
- “生产工具契约不兼容，当前链路已安全停止。”

## 企微消息固定格式

机器模板是 `../assets/wecom_inquiry_template.txt`，不得自行改行序、标签或占位符。可选的品牌/产品行没有事实时整行省略，不写“待定”。`{{...}}` 字段必须在调用 MCP 前由已校验需求和已确认表单列渲染；最终发给外部 API 的动态占位符只保留其支持的 `{project_name}`、`{deadline}`、`{form_link}`。

渲染来源固定：平台取 `platform`；品牌/产品只拼接非空 `brandName/product`；回填要求按 `contentTag → description` 顺序拼接，二者都空时只能使用媒介已确认的内容要求 audit atom，不能总结整份 Brief；数量取 `quantityTotal`；预算逐项列出实际存在的 `kolOfficialPriceL1/L2/L3` 档位与范围；截止取 `submissionDeadlineAt`；回填字段只取已确认 columns 的中文名并保持原顺序。

```text
【{project_name}｜达人提报】
平台：<platform>
品牌/产品：<brandName/product，可选>
回填要求：<contentTag → description；都为空时仅用已确认内容要求原文 atom>
需求数量：<quantityTotal> 位
单达人预算：<实际存在的 L1/L2/L3 档 + [min,max] 人民币元>
提报截止：{deadline}
回填字段：<已确认 columns 的中文名，按顺序>
请填写符合要求且可确认档期与报价的达人：{form_link}
```

外发 Ask 必须展示这段最终消息和机构名单。当前 `create_with_distributions` 的 live schema 若未声明 `notification_template`，不得把预览说成已发送；返回 `integration_required` 并等待 MCP 增加该透传字段。

## 最终 CSV 固定格式

机器模板是 `../assets/ypmcn_submission_template.csv`。成功创建提报批次后，才可用宿主 `export_csv` 渲染；第一行必须逐字节匹配该模板，Agent 不得自行增删、翻译、重排或改名。

只填 MCP 实际返回值；缺失写空单元格，不用 `0`、`未知` 或推测值代替。金额由分转元仅在源字段明确为 cents 时执行，返点由 0–1 转百分比。文件名固定为 `ypmcn_submission_<demandId>_v<demandVersion>_batch_<batchNo>.csv`。
