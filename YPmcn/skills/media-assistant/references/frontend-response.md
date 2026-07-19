# 前端回复

结论先行，只转述 MCP 已确认的阶段、数量、决策和下一步；金额显示元/万元，返点显示百分比，时间显示本地时区。不要显示完整 Brief/JSON、内部 ID、权重或状态快照、凭据、请求头、连接信息和堆栈。

每个已提交弹窗选择都是待执行命令：记录结果并在同轮执行所选动作，不得只回复“已确认”。

`search_creators` 成功后固定输出：

```markdown
### 达人供给结果
- 需求达人数量：<quantityTotal>
- 当前符合条件达人数量：<实际命中数>
- 供需比：<实际命中数>/<quantityTotal>（<比值>:1）
- 建议拓展达人数量：<Provider建议；无建议时标明“最低补量”并用 max(quantityTotal-实际命中数,0)>
- 下一步：确认后进入 MCN 赛马
```

随后用“供给确认”弹窗。`rank_mcns` 成功后按实际赛马规模展示机构名称、覆盖和缺口；不得固定 5 家，不得显示机构/推荐 ID。

企微 `description` 必须是由已确认需求和 columns 整理出的 JSON 字符串；价格键用平台内容形式/时长，不用 L 等级。调用 `create_with_distributions` 后由 Native Approval 展示最终消息与机构数量，确认即续传原调用，取消则不发送。

批次实际成功后才按 `../assets/ypmcn_submission_template.csv` 调宿主 `export_csv`。表头逐字节一致；仅填 MCP 返回值，缺失留空。只有源字段明确为 cents 或 0–1 比例时才换算。文件名固定为 `ypmcn_submission_<demandId>_v<demandVersion>_batch_<batchNo>.csv`。
