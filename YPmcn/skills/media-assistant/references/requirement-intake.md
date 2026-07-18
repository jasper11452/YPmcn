# 需求入口

运行时 Tool schema 优先；仅在非标准字段或真实冲突时查 [`reference_schema.json`](reference_schema.json) 的 61 列 `customer_demands` 快照。除控制字段 `status` 外不得传未声明字段，也不得自行推导达人表字段。

## 三态门禁

1. 先把 Brief 拆成原子需求，先完整生成缺失清单和歧义清单，再决定 gate。
2. 最小必填：`platform`、正整数 `quantityTotal`、`submissionDeadlineAt`、合法 `ypmcn-brief-v1` `rawMessagesJson`，以及 `kolOfficialPriceL1/L2/L3` 至少一项上界大于 0 的合法范围。
3. 某必填没有可用于该字段的具体候选值时为 `missing_required`；“一批/一些/尽量多”等没有数字的模糊数量仍算缺失。
4. 必填有候选但字段、档位、日期或有限端点不能唯一确定时为 `semantic_ambiguity`；可确定的单值、上限、闭区间直接规范。
5. 缺失优先于歧义，但必须一次列全；两者皆空才是 `ready`。项目、品牌、产品、项目总预算、返点等业务可选，缺失不阻断。
6. 未决时只问一次自包含问题并停止，不调用业务 Tool；不得写 `draft`、`ready`、`__UNRESOLVED__`、空串或假值。

## 映射与格式

- 小红书/XHS/红书 → `xiaohongshu`；抖音/DY/Douyin → `douyin`。数量是 JSON integer，不是范围。
- CSV/JSON 注释为范围的字段传无空格字符串 `"[min,max]"`：单值 `x→[x,x]`，上限 `x→[0,x]`，闭区间 `a-b→[a,b]`；比例先除以 100，端点有限、非负且有序。
- 除返点外，只有下限且无有限上限必须询问。返点 `30%` → `"[0.3,0.3]"`，`30%+`/`30%以上` → `"[0.3,1]"`。
- 单达人官方价：小红书图文/视频对应 L1/L2；抖音 1–20 秒、21–60 秒、60 秒以上对应 L1/L2/L3。金额或档位不明时询问。
- 项目总预算无专用列，只原文保留；账号/达人类型自然语言无法区分内容主题与平台 taxonomy 时必须询问，不猜标签 JSON。
- 档期写 `projectStartStart/projectStartEnd`，提报截止写 `submissionDeadlineAt`，统一 `YYYY-MM-DD HH:mm:ss`；相对日期以 `currentLocalDateTime + timeZone` 唯一换算，只有时刻没有日期则询问。

## 审计与预览

- 每个原子条件只能 mapped 到一个真实 payload 字段，或逐字原文保留；不漏项、不组合 disposition。未决行仅用单一 `missing_required` 或 `semantic_ambiguity` resolution。
- `rawMessagesJson` 是对象：`schemaVersion="ypmcn-brief-v1"`、完整 `originalBrief`、非空 atoms、计数一致且 `unresolvedCount=0` 的 `coverageCheck`；`sourceText` 必须是原文子串。
- preview 的 atoms、gate、summary 从同一列表生成；未决时 `toolArguments=null`，ready 时为随后逐字调用的 `{"payload": {..., "status": "ready"}}`。
- 宿主已注入权威 preview 时直接采用，不重算、不读 reference、不探测 schema；未决仅原生 Ask，若不可用则聊天询问并停止。

## 写入

`ready` 时展示并调用完全相同的 payload。新建省略 `id`，省略 `demandVersion`；补充版本只沿用上一成功响应的 `demandId`，由 Provider 分配版本。只有实际返回 `success=true`、需求主键、`status=ready`、`workflow_state` 和 `allowed_actions` 才推进；写结果未知先对账，不重放。
