# 需求入口

运行时 Tool schema 优先；只有非标准字段或冲突时查 `reference_schema.json`。不得杜撰字段、系统 ID 或达人表字段。

## 首次用户引导

用户第一次使用不知道要填什么。当 Brief 检测失败或解析出多个 `missing_required` 时，先展示模板再弹窗补充：输出带占位符的结构化需求模板，用一次 AskUserQuestion 收集缺失核心信息（平台、数量、预算、截止时间），其余字段逐步引导。

## 三态门禁

先把完整 Brief 拆成原子需求并一次生成缺失、歧义清单，再判定：必填无具体候选值为 `missing_required`；有候选但字段、档位、日期、单位或有限端点不能唯一确定为 `semantic_ambiguity`；两者皆空才为 `ready`。缺失优先但不短路诊断。未决时一次问全并停止，业务 Tool 为零；不得传 `draft`、空值、假值或 `__UNRESOLVED__`。

未决值统一用一次原生 AskUserQuestion：每个决策单独一题，同次最多三题；题头用 2–8 个中文字符概括主题，正文只写一句 4–42 字的直接问题，不加背景摘要，不展示字段名、门禁或工具术语。每题为单选，提供 2–4 个带简短说明的选项并覆盖所有不同业务选择；宿主自动提供“其他”输入，不要把“其他”再做成选项。

最小必填是 `platform`、正整数 `quantityTotal`、带秒 `submissionDeadlineAt`、合法 `ypmcn-brief-v1` `rawMessagesJson`，以及 `kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3` 至少一项上界大于零的单达人预算。项目名、品牌、产品、项目总预算和返点为业务可选；已提供则必须正确映射或原文保留。

## 归一化与审计

- 平台只用 `xiaohongshu|douyin`。小红书图文/视频对应 L1/L2；抖音 1–20、21–60、60 秒以上对应 L1/L2/L3。金额或档位不清即询问。
- 范围传无空格 `"[min,max]"`：单价 `x→[x*0.9,x*1.1]`，上限 `x→[0,x]`，闭区间 `a-b→[a,b]`；比例先除以 100。仅下限除返点外必须询问；返点 `30%+→[0.3,1]`。
- 相对时间用宿主 `currentLocalDateTime + timeZone` 唯一换算为 `YYYY-MM-DD HH:mm:ss`；不能唯一确定即询问。
- 每个 atom 只映射一个真实字段或逐字 preserved；`sourceText` 必须是原文子串。`rawMessagesJson` 保存完整原文、非空 atoms 与计数一致且 `unresolvedCount=0` 的 coverage。

`ready` 时展示并原样调用 `{"payload": {..., "status": "ready"}}`。新建省略 `id/demandVersion`；补充版本只沿用上一成功响应的 `demandId`。仅实际返回成功、需求主键、`status=ready`、`workflow_state` 和 `allowed_actions` 后推进；未知写结果先对账。
