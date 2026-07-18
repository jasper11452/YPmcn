# 需求字段解析

## 权威与类型

[`reference_schema.json`](reference_schema.json) 是 2026-07-18 只读核对的 61 列 `customer_demands` 快照；运行时 Tool schema 冲突时停止并报 `integration_required`。当前表没有 `businessIndustry`、`budget*`、`rebateMinRate`、`submissionDeadlineRaw`，不得杜撰字段。

- string 列传 JSON 字符串；`int/bigint` 传整数；`decimal` 传数值；`tinyint(1)` 传 `0|1`；datetime 传 `YYYY-MM-DD HH:mm:ss`；json 传对象/数组，不二次序列化。
- 范围型 varchar 只传 `"[min,max]"` 字符串，不传数组、比较符或目标 `*Min/*Max`。后端按 `field_match_mapping` 拆上下界，Agent 只写 source 字段。
- 物理可空与业务门禁分开：三个报价列物理可空但至少一项是业务必填；`rebate` 物理非空但业务可选，不得编造。

## 归一化

先识别字段/单位，再换算人民币元、计数或 0–1 比例，最后输出两个有限非负端点。单值两端相同；仅上限以 0 为下限；闭区间按小到大。除返点外，仅下限没有有限上限时询问。

返点上界固定为 1：`30% → rebate: "[0.3,0.3]"`，`20%-30% → "[0.2,0.3]"`，`30%+`/`30%以上`/`至少30% → "[0.3,1]"`，并保留原文 atom。

## 关键例子

- 粉丝 10–30 万 → `followercount: "[100000,300000]"`；女性粉丝不低于 50% 且确认上限 100% → `femaleRate: "[0.5,1]"`。
- 小红书图文单人预算 5000 元 → `kolOfficialPriceL1: "[5000,5000]"`；小红书视频用 `kolOfficialPriceL2`。
- 抖音 1–20 秒、21–60 秒、60 秒以上分别使用 `kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3`；21–60 秒 3000–5000 元 → `kolOfficialPriceL2: "[3000,5000]"`。
- 项目总预算只逐字进入 `rawMessagesJson`；“账号类型：母婴类、亲子相关”先判 `semantic_ambiguity`，确认内容主题后才写 `contentTag`，平台 taxonomy 只接受真实 JSON 标签。

## 完整性

每条原文拆成不可再分的 atom；mapped 只能有一个真实 `targetField`，preserved 必须逐字。反向核对原 Brief，遗漏、虚构字段、错误类型、未规范范围、价格档位不明或伪造系统字段都阻断 `validate_requirement`。平台仅 `xiaohongshu|douyin`；相对时间按宿主时钟换算，无法唯一确定才询问。
