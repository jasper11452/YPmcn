# validate_requirement

## 何时调用

新 Brief、补充或变更进入链路时调用。

## 输入

必填 `payload`，完整结构按当前 schema 传入。

本 Tool 没有 dry-run、schema 查询或预检模式，每次成功调用都会写数据库。禁止用 `__SCHEMA_CHECK__`、`dry run`、`probe`、占位项目或空 Brief 调用；schema 只能读取宿主已经提供的工具定义。第一次调用必须是经过预览和评分的真实 payload。

## 调用前硬门禁

调用前必须完成 `../requirement-intake.md` 的简洁用户可见预览和 100 分制评分。只展示字段、值、未决项、总分和硬阻断结论，不输出逐步推理。只有 `score > 80` 且硬阻断清单为空时才调用；`score === 80` 也禁止调用。不得先调用再补展示。

预览中的 payload 必须与实际工具参数一致。展示后若又修改任何字段，必须重新展示并重新评分。

## 高频字段优先匹配

字段名和输入格式以运行时 schema 为语法权威，以本文件的高频映射为业务补充。解析 Brief 或组装
`payload` 时，先匹配下列高频字段，再按对应 `Type` 生成并校验值；
禁止把中文业务名直接当作字段名，也禁止构造 schema 中不存在的字段。

### 需求主字段

| 优先级 | 业务含义 | schema 字段 | 写入规则 |
|---|---|---|---|
| P0 | 平台 | `platform` | 规范为 `xiaohongshu` 或 `douyin` |
| P0 | 达人官方报价 | `kolOfficialPriceL1`, `kolOfficialPriceL2`, `kolOfficialPriceL3` | 小红书与抖音统一按明确档位写 `decimal(12,2)` 人民币元单值；不得写入 `budget*` |
| P0 | 项目总预算 | `budgetMinCents`, `budgetMaxCents`, `budgetRaw` | 仅处理明确的整体/项目总预算；金额统一为分并保留原文 |
| P0 | 达人类型 | `talentTypeLabel`, `pgyBloggerTypeLabel`, `xtTalentTypeLabel`, `growTalentTypeLabel` | 仅按平台已有标签的原文精确值写入；L1/L2/L3 报价档位不是达人类型标签，不得映射到这些字段 |
| P0 | 内容形式 | `contentFeatureLabel`, `kolOfficialPriceOther` | 内容特征写标签；只有 L1/L2/L3 无法表达的发文类型报价才写报价 JSON |
| P0 | 品类 / 行业 | `businessIndustry` | “品类”“行业”写普通字符串；例如“母婴”写 `businessIndustry: "母婴"`，同时在原文 JSON 保留完整约束 |
| P0 | 内容方向 / 标签 | `contentThemeLabel`, `contentTag`, `industryTagLabel` | 明确说“内容方向/主题”才写主题，明确说“内容标签”才写 `contentTag`；JSON 标签字段只有原文提供现成标签结构时才写 |
| P1 | DDL / 提交时间 | `submissionDeadlineAt`, `submissionDeadlineRaw` | 可解析时间写 `At`，始终保留原文 |
| P1 | 返点 | `rebateMinRate`, `rebateMaxRate`, `rebateRaw` | 比例写数值区间；同时保留原文 |
| P1 | 档期 / 项目时间 | `projectStartStart`, `projectStartEnd` | 写可确认的起止时间 |
| P1 | 地域 | `kwProvince`, `kwCity`, `cityLevel` | 依次匹配省、市、城市等级 |
| P1 | 达人性别 / 年龄 | `kwGender`, `age` | 只写明确约束 |
| P1 | 粉丝性别 | `femaleRate`, `maleRate` | 写明确占比条件 |
| P1 | 粉丝年龄 | `age1Rate`—`age6Rate` | 仅在原文与当前平台已有年龄段明确对应时写入，否则保留原文 |
| P1 | 粉丝量 / 数据要求 | `followercount`, `realityFollowercount`, `realityfollowerrate` | 只有明确单值才写对应字段；“10万以上”等范围/比较条件没有 min/max 专用字段，直接保留在 `rawMessagesJson`，禁止查 CSV 或把下限写成单值 |
| P2 | 项目 / 品牌 / 产品 | `projectName`, `brandName`, `product` | 分别写入，不合并 |
| P2 | 数量 | `quantityTotal` | 仅写可确认的达人需求总数 |

### 高频但无专用字段

`负向要求`、`排竞/授权` 等未在上表列出专用字段的约束，
保留在 `rawMessagesJson`，不得杜撰字段。无法可靠结构化的原始总预算、返点、
DDL 分别落入对应 `*Raw` 字段；其他原始需求统一保留在 `rawMessagesJson`。

### 常用 payload 类型

- 字符串：`projectName`、`brandName`、`platform`、`businessIndustry`、各 `*Raw`。
- 整数：`quantityTotal`。
- 人民币元 decimal：`kolOfficialPriceL1/L2/L3`。
- 比例 decimal：`rebateMinRate/rebateMaxRate`，30% 写 `0.3`。
- 时间字符串：`projectStartStart/projectStartEnd/submissionDeadlineAt`，按运行时 schema 接受的格式传入。
- JSON：`rawMessagesJson` 传对象；不把范围条件拆成数据库不存在的字段。
- 枚举：仅完整无歧义时写 `status: "ready"`；待澄清时停止并询问用户，不调用本 Tool 写 `draft`。

上述常用类型已经足够组装普通 Brief，禁止为确认这些类型读取 CSV 或调用 shell。

### 官方报价映射

1. “达人报价”“官方价”“刊例价”“单人预算”“单人价格”或与具体发文类型绑定的金额，按报价条件处理，不按项目总预算处理。
2. 小红书和抖音都写入 `kolOfficialPriceL1/L2/L3`。抖音 1–20 秒、21–60 秒、60 秒以上分别对应 L1、L2、L3；小红书按原文明确的 L1/L2/L3 档位对应。
3. 原文只有“达人层级 L1/L2/L3”并同时给出对应官方报价时，将其视为报价档位证据；不得据此写 `talentTypeLabel` 等 JSON 标签字段。只有原文提供数据库已有的明确达人类型标签时才写标签字段。
4. 官方报价字段为 `decimal(12,2)`，只写有证据的人民币元单值，不套用项目总预算的元转分规则。原文同时给出多个明确档位和单值时分别写入。
5. 档位无法确定，或原文只有区间/比较条件而没有确定数值时，保留原文并请求最小确认，不得把非数值条件塞入 decimal，也不得回退写入 `budget*`。
6. 只有明确的项目总预算、整体预算或总成本上限才写 `budgetMinCents/budgetMaxCents/budgetRaw`。

### 完整性检查

调用前对原文逐句建立覆盖清单，重点检查 `quantityTotal`、`rebateMinRate/rebateMaxRate/rebateRaw`、`projectStartStart/projectStartEnd`、`submissionDeadlineAt/submissionDeadlineRaw` 和 `kolOfficialPriceL1/L2/L3`。明确值缺少专用字段映射时不得用 `note` 或 `description` 代替。

### 匹配顺序

1. 使用本文件的高频映射，不读取数据库 CSV，不使用 shell/exec/grep 查字段。
2. 按运行时 schema 规范化值并逐字段校验；数值、布尔和 JSON 不得无条件字符串化。
3. 仅在运行时 schema 存在、原文有证据且值通过类型校验时写入；未命中、格式不合法或有歧义时保留原文并停止猜测。

以上优先级来自已脱敏需求样本的字段频次统计；不得在运行时暴露内部会话身份或原始样本。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

只依据实际返回判断能否继续；缺需求 ID 或状态证据时停止。

## 能力边界

仓库只证明输入契约和字段校验；不提供自然语言/语音转写解析器，也未验证生产 Provider 的写入结果。需求编辑、版本恢复和下游一致性仍需实际系统证据。

## 错误与停止条件

不得编造需求字段。写结果未知时先对账，不盲目重试。

- 完整性评分通过且无硬阻断时，payload 必须显式传 `status: "ready"`；存在待澄清项时禁止调用，不得传 `status: "draft"` 试错。
- `id` 是每个数据库版本行的不可复用主键。首次创建和后续补充都不得回传上一响应的 `id`。
- 同一需求补充时，将上一成功响应的 `demand_id` 映射为 payload 字段 `demandId`，省略 `demandVersion`，由 Provider 原子分配下一版本；不得自行递增、创建新 `demandId` 或覆盖旧版本。
- 返回 Draft、非 ready、缺失、冲突或待确认项时，立即提出对应的最小澄清问题。用户回答后按上一条创建同一 `demandId` 的下一版本；若写结果未知，先用原 `demand_id + demand_version` 查询对账，不得重放写入。
