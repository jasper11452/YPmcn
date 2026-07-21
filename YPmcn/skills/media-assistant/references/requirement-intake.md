# 需求入口

运行时 Tool schema 优先；只有非标准字段或冲突时查 `reference_schema.json`。不得杜撰字段、系统 ID 或达人表字段。

## 首次用户引导

用户第一次使用不知道要填什么。当 Brief 检测失败或解析出多个 `missing_required` 时，先展示模板再弹窗补充：输出带占位符的结构化需求模板，用一次 AskUserQuestion 收集缺失核心信息（平台、数量、预算、截止时间），其余字段逐步引导。

## 三态门禁

先把完整 Brief 拆成原子需求并一次生成缺失、歧义清单，再判定：必填无具体候选值为 `missing_required`；有候选但字段、档位、日期、单位或有限端点不能唯一确定为 `semantic_ambiguity`；两者皆空才为 `ready`。缺失优先但不短路诊断。未决时一次问全并停止，业务 Tool 为零；不得传 `draft`、空值、假值或 `__UNRESOLVED__`。

未决值统一用一次原生 AskUserQuestion：每个决策单独一题，同次最多三题；题头用 2–8 个中文字符概括主题，正文只写一句 4–42 字的直接问题，不加背景摘要，不展示字段名、门禁或工具术语。每题为单选，提供 2–4 个带简短说明的选项并覆盖所有不同业务选择；宿主自动提供“其他”输入，不要把“其他”再做成选项。

最小必填是 `platform`、正整数 `quantityTotal`、带秒 `submissionDeadlineAt`、合法 `ypmcn-brief-v1` `rawMessagesJson`，以及一个平台合法且上界大于零的单达人预算字段。小红书只允许图文/视频两类，抖音允许三个视频时长；项目名、品牌、产品、项目总预算和返点为业务可选。

## 归一化与审计

- 平台只用 `xiaohongshu|douyin`。用户侧只说“小红书图文价格/视频价格”或“抖音1–20秒/21–60秒/60秒以上视频价格”，绝不显示 L1/L2/L3。内部映射使用 `kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3`；小红书禁止 `kolOfficialPriceL3`。
- 范围传无空格 `"[min,max]"`：只说预算单值 `x` 且无“以内/不超过”等上限词或区间端点时，按默认最大预算基准扩为 `[x*0.9,x*1.1]`；明确上限 `x→[0,x]`，闭区间 `a-b→[a,b]`。先换算元、万等单位再计算；比例先除以 100。仅下限除返点外必须询问；返点 `30%+→[0.3,1]`。
- 粉丝年龄 `age1Rate..age6Rate` 直接传 0–1 JSON 数值（`20%→0.2`），不用范围。档位：小红书 `<18/18–23/24–29/30–39/40–49/50+`；抖音 `<18/18–23/24–30/31–40/41–50/50+`；跨档或错平台不映射。
- `hasOrganization`、`hasOrder30day`、`hasSocial30day` 只传 JSON 布尔值 `true/false`，不用 `0/1` 或字符串。
- 相对时间用宿主 `currentLocalDateTime + timeZone` 唯一换算为 `YYYY-MM-DD HH:mm:ss`；不能唯一确定即询问。
- 每个 atom 只映射一个真实字段或逐字 preserved；`sourceText` 必须非空，可引用原始 Brief 或本轮 AskUserQuestion 的明确补充答案，不能为了满足审计而篡改 `originalBrief`。`rawMessagesJson` 保存完整原文、非空 atoms 与计数一致且 `unresolvedCount=0` 的 coverage。

`ready` 时展示并原样调用 `{"payload": {..., "status": "ready"}}`。每次手扒前都按新建需求处理并省略旧 `id/demandVersion`；仅实际成功响应新生成的需求主键可授权紧邻的一次手扒，禁止复用。非手扒的补充版本才沿用上一成功响应的 `demandId`。Provider `workflow_state/allowed_actions` 不覆盖本地 phase，未知写结果先对账。

## 参数自修复

若 Hook 或 Provider 明确返回字段、类型、范围、映射、canonical input 或审计计数冲突，且用户已确认内容能唯一确定正确参数，说明本次没有形成成功写入。保持 `originalBrief` 和所有已确认业务语义不变，只修报错位置并在同一轮重新调用 `validate_requirement`；后续出现新的确定性参数错误就继续修，直到实际成功。不得把 Agent 的解析或序列化错误转嫁为用户确认，也不得要求用户发送“继续”。只有修复需要用户输入中不存在的业务选择时才弹一次参数确认；超时、连接错误、服务端通用错误和写结果未知不进入本循环。
