# validate_requirement

## 何时调用

新 Brief、补充或变更进入链路时调用。

## 输入

必填 `payload`，完整结构按当前 schema 传入。

## 高频字段优先匹配

字段名以相邻的 `../reference_schema.csv` 为唯一准绳。解析 Brief 或组装
`payload` 时，先在该表中匹配下列高频字段；禁止把中文业务名直接当作字段名，
也禁止构造 schema 中不存在的字段。

### 需求主字段

| 优先级 | 业务含义 | schema 字段 | 写入规则 |
|---|---|---|---|
| P0 | 平台 | `platform` | 规范为 `xiaohongshu` 或 `douyin` |
| P0 | 预算 | `budgetMinCents`, `budgetMaxCents`, `budgetRaw` | 金额统一为分；同时保留原文 |
| P0 | 达人类型 | `talentTypeLabel`, `pgyBloggerTypeLabel`, `xtTalentTypeLabel`, `growTalentTypeLabel` | 按平台及原文命中已有标签字段，不确定时不猜 |
| P0 | 内容形式 | `contentFeatureLabel`, `kolOfficialPriceOther` | 内容特征写标签；按发文类型报价写报价 JSON |
| P0 | 内容方向 | `contentThemeLabel`, `contentTag`, `industryTagLabel`, `businessIndustry` | 优先主题/内容标签，再匹配行业 |
| P1 | DDL / 提交时间 | `submissionDeadlineAt`, `submissionDeadlineRaw` | 可解析时间写 `At`，始终保留原文 |
| P1 | 返点 | `rebateMinRate`, `rebateMaxRate`, `rebateRaw` | 比例写数值区间；同时保留原文 |
| P1 | 档期 / 项目时间 | `projectStartStart`, `projectStartEnd` | 写可确认的起止时间 |
| P1 | 地域 | `kwProvince`, `kwCity`, `cityLevel` | 依次匹配省、市、城市等级 |
| P1 | 达人性别 / 年龄 | `kwGender`, `age` | 只写明确约束 |
| P1 | 粉丝性别 | `femaleRate`, `maleRate` | 写明确占比条件 |
| P1 | 粉丝年龄 | `age1Rate`—`age6Rate` | 按 schema 注释对应平台年龄段 |
| P1 | 粉丝量 / 数据要求 | `followercount`, `realityFollowercount`, `realityfollowerrate` | 按原文区分总粉丝、真实/有效粉丝及比例 |
| P2 | 项目 / 品牌 / 产品 | `projectName`, `brandName`, `product` | 分别写入，不合并 |
| P2 | 数量 | `quantityTotal` | 仅写可确认的达人需求总数 |

### 高频但无专用字段

`负向要求`、`排竞/授权` 等约束若在 `reference_schema.csv` 中没有专用字段，
保留在 `rawMessagesJson`，不得杜撰字段。无法可靠结构化的原始预算、返点、
DDL 分别落入对应 `*Raw` 字段；其他原始需求统一保留在 `rawMessagesJson`。

### 匹配顺序

1. 每次调用前读取 `../reference_schema.csv`，先精确匹配上表中的高频字段。
2. 再按 CSV 的 `Comment` 判断平台语义和单位，尤其注意两平台年龄段、报价档位差异。
3. 仅在 schema 存在且原文有证据时写入；未命中或有歧义时保留原文并停止猜测。

以上优先级来自 Claude Code 会话 `7ac17764-97bc-42a5-bc1b-bdb91d7429a5`
对 239 条小红书需求和 30 条抖音需求的字段频次统计。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

只依据实际返回判断能否继续；缺需求 ID 或状态证据时停止。

## 能力边界

仓库只证明输入契约和字段校验；不提供自然语言/语音转写解析器，也未验证生产 Provider 的写入结果。需求编辑、版本恢复和下游一致性仍需实际系统证据。

## 错误与停止条件

不得编造需求字段。写结果未知时先对账，不盲目重试。
