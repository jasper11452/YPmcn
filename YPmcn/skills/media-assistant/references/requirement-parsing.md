# 需求字段解析

## 权威字段

`reference_schema.csv` 是当前字段权威。`customer_demands`、`xhs_creator_accounts`、`dy_creator_accounts` 和候选搜索使用同名字段时必须保持语义一致；不擅自改列名或造同义列。

## 两遍解析

第一遍逐句拆分原子需求，至少检查：项目名、平台、达人数量、达人类型、内容方向、账号画像、参考账号、官方报价、项目总预算、返点、项目档期、提报截止、地域/性别/年龄、效果指标、负向要求和紧急程度。

第二遍为每条原子需求记录处置结果：

- 有明确字段和确定值：写入字段。
- 有明确字段但值或档位不确定：进入歧义清单，禁止猜测。
- 没有可靠专用字段：完整保留到 `rawMessagesJson`，不得塞进含义相近但错误的字段。

组装完成后反向逐条核对原 Brief。任何原子需求没有字段、原文保留或歧义记录，视为解析遗漏并阻断调用。

## 常用映射

| 用户表达 | 参数 |
|---|---|
| 小红书 / XHS / 红书 | `platform=xiaohongshu` |
| 抖音 / DY / Douyin | `platform=douyin` |
| 人数 | `quantityTotal` 正整数 |
| 项目总预算 / 整体预算 3 万元 | `budgetMinCents`、`budgetMaxCents`、`budgetRaw`；金额写分 |
| 达人官方价 / 刊例价 / 单人预算 / 单人价格 | 按明确档位和 `text` 类型写 `kolOfficialPriceL1`、`kolOfficialPriceL2` 或 `kolOfficialPriceL3` |
| 20% 返点 | `0.2` |
| 截止时间 | 带时区 `submissionDeadlineAt`，并写 `submissionDeadlineRaw` |
| 内容与类目 | `contentThemeLabel`、`contentTag`、`industryTagLabel`、`businessIndustry` 等已声明字段 |

## 官方报价档位

- 小红书和抖音统一使用 `kolOfficialPriceL1`、`kolOfficialPriceL2`、`kolOfficialPriceL3` 承载达人官方报价筛选，不得写入 `budgetMinCents`、`budgetMaxCents` 或 `budgetRaw`。
- 官方报价字段类型为 `text`，按原文证据保留单值或区间条件；不得套用项目总预算的“元转分”规则。
- 抖音按视频时长映射：1–20 秒 → `kolOfficialPriceL1`，21–60 秒 → `kolOfficialPriceL2`，60 秒以上 → `kolOfficialPriceL3`。
- 小红书按原文明确的 L1/L2/L3 档位写入对应字段；原文未给出可确定档位时保留原文并请求最小确认，不猜档位。
- 同一 Brief 明确包含多个报价档位时分别写入对应字段；只有无法由 L1/L2/L3 表达的发文类型报价才使用 `kolOfficialPriceOther`。
- 只有明确表达为项目总预算、整体预算或总成本上限的金额才使用 `budget*` 系列字段。不得仅因出现“预算”二字，就把“单人预算”或与发文类型绑定的价格写入 `budget*`。

## 高频表达补全

- “要/需/找 N 个、N 位达人” → `quantityTotal=N`。
- “返点 30%+、不低于 30%” → `rebateMinRate=0.3`，同时保留 `rebateRaw`；没有上限证据时不填写 `rebateMaxRate`。
- “档期 7.30–7.31” → `projectStartStart/projectStartEnd`；年份不能唯一确定时列为歧义，不自行补年。
- “最晚明天上午 11 点提报” → `submissionDeadlineAt` 和 `submissionDeadlineRaw`，按当前时区解析并检查是否为未来时间。
- 明确数量、返点、档期或截止时间不得只塞入 `note`/`description`，必须优先写专用字段。
- 参考账号、主观审美、负向要求以及没有数值阈值的“互动高、评论真实”等要求，在没有可靠专用需求字段时保留到 `rawMessagesJson`；不得误写为候选达人事实字段。
- 不主动提交 `status=ready`；ready 只能依据 `validate_requirement` 的实际返回判断。

## 示例覆盖基线

对于“千问61儿童节”示例，至少识别并处置：`projectName`、`platform`、`quantityTotal=2`、`rebateMinRate=0.3`、`rebateRaw=30%+`、项目档期、提报截止、母婴亲子账号、内容方向、参考账号、价格 4w、不要低龄吃奶粉、不要僵硬口播、孩子颜值要求、阅读与报价关系、互动要求、评论真实性和紧急程度。价格 4w 未给出小红书 L1/L2/L3 档位时必须列为硬阻断，不得写入 `budget*`，也不得调用落库。

## 冲突处理

同一字段存在冲突时保留原始消息并请求一次最小确认。Agent 修正解析不代表客户需求变更；是否产生新版本由业务 MCP 决定。没有 schema 字段承载的信息放入已声明的 JSON 扩展，不塞入无关列。

平台写入只允许 `xiaohongshu`、`douyin`；`xhs`、`dy` 仅作为用户输入别名解析，禁止写入数据库或传给业务 Tool。
