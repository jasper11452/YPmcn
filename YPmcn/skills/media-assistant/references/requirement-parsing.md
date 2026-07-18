# 需求字段解析

## 真实字段权威

`reference_schema.csv` 是 2026-07-18 从 YP 开发 MySQL `ypmcn.customer_demands` 只读核对的 61 列快照。`Field`、`Type`、`Null`、`Key`、`Default`、`Extra` 与真实表逐项一致；`Comment` 在数据库原注释上补充 Agent 输入边界。不得引用旧 CSV 中的达人表字段，也不得创建 `businessIndustry`、`budget*`、`rebateMinRate`、`submissionDeadlineRaw` 等不存在的字段。

数据库可空性与 Brief 业务门禁分开：系统字段可由 Provider 生成；三个单达人官方报价列物理可空，但业务要求至少一个合法范围。`rebate` 物理非空但业务可选，Agent 不得为了通过数据库约束而编造客户返点。

## 类型规则

- `char(N)` / `varchar(N)` / `text`：JSON 字符串，不超过列长度。
- CSV 注释为“范围”的 `varchar(255)`：只允许规范字符串 `"[min,max]"`，不是 JSON 数组。两端为有限非负数且 `min <= max`；比例范围还必须在 0–1。
- `int` / `bigint`：JSON 整数，不带单位和千分位。
- `decimal(P,S)`：JSON 数值，最多 S 位小数；比例 50% 写 `0.5`。
- `tinyint(1)`：写 `1` 或 `0`。
- `enum`：只写枚举值。
- `datetime`：写 `YYYY-MM-DD HH:mm:ss`。
- `json`：写实际 JSON 对象或数组，不二次序列化。

范围归一化只有四步：识别字段与单位 → 换算人民币元/计数/0–1 比例 → 得到两个有限端点 → 输出无空格 `"[min,max]"`。确定单值写相同两端；只有上限时非负指标下限写 0；明确闭区间按小到大写。比例的每个百分数端点都先除以 100，例如 `30%` → `0.3`。除返点外，只有下限而没有业务确认的有限上限时必须询问，不能使用 `null`、`Infinity`、空字符串或任意大数。

返点是上界固定为 100% 的比例区间：确定值 `30%` → `rebate: "[0.3,0.3]"`；闭区间 `20%-30%` → `rebate: "[0.2,0.3]"`；`30%+`、`30%以上`、`至少 30%`、`不低于 30%` 及等价的“至少”措辞都表示开口下限并补全业务上界 1，统一写 `rebate: "[0.3,1]"`。不得把这些表达原样写入 `rebate`，也不得因缺少显式上限而询问。

## 与映射表的边界

Agent 只写 `customer_demands` 的 source 字段。`validate_requirement` 落库后，后端在搜索/手扒链路按平台和 source 字段读取 `field_match_mapping`，再把 `[min,max]` 拆给该行已确认的目标 Min/Max 参数。Agent 不应：

- 自己去掉目标字段的 `Min` / `Max` 后缀；
- 把目标参数写进需求表；
- 直接查询或猜达人表列；
- 因为不同 source 字段共享目标参数名而否定已确认映射。

## 解析例子

- “粉丝 10–30 万” → `followercount: "[100000,300000]"`。
- “女性粉丝不低于 50%”只给出了下限，若没有确认上限则询问；确认上限为 100% 后写 `femaleRate: "[0.5,1]"`。
- “图文互动率不超过 5%” → `photoInteract: "[0,0.05]"`。
- “小红书图文单达人预算 5000 元” → `kolOfficialPriceL1: "[5000,5000]"`。
- “抖音 21–60 秒报价 3000–5000 元” → `kolOfficialPriceL2: "[3000,5000]"`。
- “抖音 60 秒以上报价不超过 8000 元” → `kolOfficialPriceL3: "[0,8000]"`。
- “返点 30%+”或“返点 30%以上” → `rebate: "[0.3,1]"` 并保留原文 atom。
- “项目总预算 3 万” → 仅保留到 `rawMessagesJson`；当前表无总预算列。
- “母婴亲子、不要低龄奶粉、评论真实” → 能精确作为内容标签的部分写 `contentTag`，其余逐字 preserved；不塞进无关达人事实字段。

## 完整性规则

每个原子条件必须是 mapped 或 preserved。mapped atom 的目标字段必须真实存在于 payload 且值通过上述类型规则；preserved atom 必须逐字保留。最后反向核对原文，任何遗漏、字段杜撰、范围未规范、比例未换算、价格档位不明或系统字段被 Agent 伪造都阻断 `validate_requirement`。

平台只写 `xiaohongshu` 或 `douyin`。相对时间按宿主注入的当前时间与时区唯一换算；无法唯一确定日期、年份或范围端点时才询问，不重复询问已经可以确定的信息。
