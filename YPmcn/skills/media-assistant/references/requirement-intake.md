# 需求入口

运行时 Tool schema 优先；只有非标准字段或冲突时查 `reference_schema.json`。不得杜撰字段、系统 ID 或达人表字段。

## 三态门禁

先把完整 Brief 拆成原子需求并一次生成缺失、歧义清单，再判定：必填无具体候选值为 `missing_required`；有候选但字段、档位、日期、单位或有限端点不能唯一确定为 `semantic_ambiguity`；两者皆空才为 `ready`。缺失优先但不短路诊断。未决时一次问全并停止，业务 Tool 为零；不得传 `draft`、空值、假值或 `__UNRESOLVED__`。

最小必填是 `platform`、正整数 `quantityTotal`、带秒 `submissionDeadlineAt`、合法 `ypmcn-brief-v1` `rawMessagesJson`，以及 `kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3` 至少一项上界大于零的单达人预算。项目名、品牌、产品、项目总预算和返点为业务可选；已提供则必须正确映射或原文保留。

## 归一化与审计

- 平台只用 `xiaohongshu|douyin`。小红书图文/视频对应 L1/L2；抖音 1–20、21–60、60 秒以上对应 L1/L2/L3。金额或档位不清即询问。
- 范围传无空格 `"[min,max]"`：单值 `x→[x,x]`，上限 `x→[0,x]`，闭区间 `a-b→[a,b]`；比例先除以 100。仅下限除返点外必须询问；返点 `30%+→[0.3,1]`。
- 相对时间用宿主 `currentLocalDateTime + timeZone` 唯一换算为 `YYYY-MM-DD HH:mm:ss`；不能唯一确定即询问。
- 每个 atom 只映射一个真实字段或逐字 preserved；`sourceText` 必须是原文子串。`rawMessagesJson` 保存完整原文、非空 atoms 与计数一致且 `unresolvedCount=0` 的 coverage。

`ready` 时展示并原样调用 `{"payload": {..., "status": "ready"}}`。新建省略 `id/demandVersion`；补充版本只沿用上一成功响应的 `demandId`。仅实际返回成功、需求主键、`status=ready`、`workflow_state` 和 `allowed_actions` 后推进；未知写结果先对账。
