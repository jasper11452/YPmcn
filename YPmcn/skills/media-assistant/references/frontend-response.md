# 前端回复

结论先行，只转述 MCP 事实；金额用元/万元、返点用百分比、时间用本地时区。隐藏 Brief/JSON、内部 ID、权重、状态快照、凭据和堆栈。

每个已提交弹窗选择都是待执行命令：记录结果并在同轮执行所选动作，不得只回复“已确认”。

`search_creators` 成功后固定输出：

```markdown
### 达人供给结果
- 需求达人数量：<quantityTotal>
- 当前符合条件达人数量：<实际命中数>
- 供需比：<实际命中数>/<quantityTotal>（<比值>:1）
- 硬缺口：<Provider hard_shortfall_count>
- 风险缓冲缺口：<Provider buffer_shortfall_count>
- 供给风险：<Provider supply_risk_level>
- 建议手扒新增：<Provider suggested_expansion_count>
- 下一步：<高风险时启动手扒并继续 MCN 赛马；其他情况按实际建议>
```

只用同一 Provider 记录；缺失/矛盾或高风险补量非正数时显示“供给计划不完整”，禁止用 `max(需求量-命中数,0)` 回退。高风险“供给确认”用真实换行重复事实，三项为“启动手扒并开始MCN赛马”“仅开始MCN赛马”“调整手扒数量”；调整只收一个正整数，其他结果不调用业务 Tool。

`manual_source_creators({requirement_id,target_count})` 只有同一记录返回完整任务证据时才展示“已启动/已沿用”并继续 `rank_mcns`；不展示任务 ID。证据不足即恢复，不能跳到外发。赛马结果只显示实际规模、机构名、覆盖和缺口。

企微 `description` 仅据确认需求生成微信纯文本，不得 JSON 化、暴露字段或杜撰；价格用平台内容形式/时长。首次 `create_with_distributions` 仅预检，原样使用 `<AskUserQuestionInput>`；只有“确认发送”才同参数外发。

批次实际成功后才按 `../assets/ypmcn_submission_template.csv` 调宿主 `export_csv`。表头逐字节一致；仅填 MCP 返回值，缺失留空。只有源字段明确为 cents 或 0–1 比例时才换算。文件名固定为 `ypmcn_submission_<demandId>_v<demandVersion>_batch_<batchNo>.csv`。
