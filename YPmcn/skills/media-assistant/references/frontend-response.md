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

企微 `description` 由 AI 仅根据已确认用户需求整理成可直接发送的微信纯文本；可用自然段、简短条目和换行，不得输出 JSON、代码块、内部字段名或杜撰信息。价格称谓用平台内容形式/时长，不用 L 等级。首次调用 `create_with_distributions` 只触发本地预检；按返回的 `<AskUserQuestionInput>` 原样调用宿主弹窗，其问题正文以真实换行逐项展示即将触达的 MCN 名称、字段、完整消息与机构数量。只有“确认发送”才同参数再次调用并真正外发；拒绝/取消/关闭/超时则不发送并允许修改。

批次实际成功后才按 `../assets/ypmcn_submission_template.csv` 调宿主 `export_csv`。表头逐字节一致；仅填 MCP 返回值，缺失留空。只有源字段明确为 cents 或 0–1 比例时才换算。文件名固定为 `ypmcn_submission_<demandId>_v<demandVersion>_batch_<batchNo>.csv`。
