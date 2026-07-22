# 需求入口

运行时 Tool schema 优先；只有非标准字段或冲突时查 `reference_schema.json`。不得杜撰字段、系统 ID 或达人表字段。

## 首次用户引导

Brief 不完整时先展示模板，再用一次 AskUserQuestion 收集平台、数量、预算和截止时间。

## 三态门禁

先把完整 Brief 拆成原子需求并生成缺失、歧义清单：必填无候选值为 `missing_required`；候选值不能唯一映射为 `semantic_ambiguity`；两者皆空才为 `ready`。未决时一次问全，业务 Tool 为零；禁传 `draft`、空值、假值或 `__UNRESOLVED__`。

未决值用一次原生 AskUserQuestion，同次最多五题，每题 2–6 个单选项；不展示字段、门禁或 Tool 术语，也不自建“其他”。价格只说“小红书图文/视频”或“抖音1–20秒/21–60秒/60秒以上”，不得展示内部价格字段，也不得声称图文对应某视频时长。

最小必填是 `platform`、正整数 `quantityTotal`、带秒 `submissionDeadlineAt`、合法 `ypmcn-brief-v1` `rawMessagesJson` 及一个上界大于零的平台单达人预算字段；项目总预算等其余项为业务可选。

## 归一化与审计

- 平台只用 `xiaohongshu|douyin`。用户侧只说“小红书图文价格/视频价格”或“抖音1–20秒/21–60秒/60秒以上视频价格”，绝不显示 L1/L2/L3。内部映射使用 `kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3`；小红书禁止 `kolOfficialPriceL3`。
- 范围传无空格 `"[min,max]"`：只说预算单值 `x` 且无“以内/不超过”等上限词或区间端点时，按默认最大预算基准扩为 `[x*0.9,x*1.1]`；明确上限 `x→[0,x]`，闭区间 `a-b→[a,b]`。先换算元、万等单位再计算；比例先除以 100。仅下限除返点外必须询问；返点 `30%+→[0.3,1]`。
- 粉丝年龄 `age1Rate..age6Rate` 直接传 0–1 JSON 数值（`20%→0.2`），不用范围。档位：小红书 `<18/18–23/24–29/30–39/40–49/50+`；抖音 `<18/18–23/24–30/31–40/41–50/50+`；跨档或错平台不映射。
- `hasOrganization`、`hasOrder30day`、`hasSocial30day` 只传 JSON 布尔值 `true/false`，不用 `0/1` 或字符串。
- 相对时间用宿主 `currentLocalDateTime + timeZone` 唯一换算为 `YYYY-MM-DD HH:mm:ss`；不能唯一确定即询问。
- atom 只映射一个真实字段或逐字 preserved；`sourceText` 可来自原始 Brief 或明确补充答案。不得篡改 `originalBrief`；补充数量、形式/时长、截止时刻各成 atom。多平台需求共用完整 `originalBrief`，另一平台条款逐字 preserved；禁加“需求A”“快手”等标记。`rawMessagesJson` 的 atoms 非空、计数一致且 `unresolvedCount=0`。

`ready` 时展示并原样调用 `{"payload": {..., "status": "ready"}}`。`search_creators.id` 和 `manual_source_creators.requirement_id` 只复制 `validate_requirement.data.id` 的 32 位主键，数字型 `data.demand_id` 只用于需求版本语义。主键格式错误直接从当前响应纠正，不得重新验证；宿主 Hook 上下文不兼容时停止。每次手扒前都按新建需求处理并省略旧 `id/demandVersion`；仅实际成功响应新生成的需求主键可授权紧邻的一次手扒，禁止复用。非手扒的补充版本才沿用上一成功响应的 `demandId`。Provider `workflow_state/allowed_actions` 不覆盖本地 phase，未知写结果先对账。

## 参数自修复

确定性参数错误仅修报错处并保持 `originalBrief` 与已确认语义；可唯一修复时同轮重调 `validate_requirement`，不得让用户发“继续”。需要新业务选择才询问；超时、连接/服务错误和写结果未知不重试。
