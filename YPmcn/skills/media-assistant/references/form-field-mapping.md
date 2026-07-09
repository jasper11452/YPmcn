# 表单字段映射

本文件定义 Brief 字段、数据库字段、筛选字段和 MCN 回填表单字段的强映射。表单字段不是固定模板，必须由已确认的结构化 brief 和数据库可用字段生成。

## 核心原则

1. Brief 里确认的数据要求必须进入后续表单字段；例如客户要求 CTR，表单必须包含 CTR 或明确标记资源库缺字段。
2. 数据库没有的字段不能用虚拟值硬测；应提示媒介/采购补充真实资源库。
3. 表单字段生成后必须停下让媒介确认，媒介可增减字段后再发送企微。
4. 字段是否参与筛选由 MCP 和数据库事实决定，Skill 只负责提示和流程控制。
5. 需求主表固定为 `customer_demands`，字段以 `references/creator_candidate_pool_schema.csv` 的 `字段` 列为准；达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`，字段从需求主表继承后再决定是否能进表单。

## 常用字段映射

| Brief 表达 | 数据库/结构化落点 | 筛选用途 | 表单字段 | 确认规则 |
|---|---|---|---|---|
| 平台 | `customer_demands.platform` | 硬筛 | 平台 | 必填，缺失阻断 |
| 达人数量 | `customer_demands.quantity_total` | 供给倍数、提报数量 | 可提报数量 | 必填，缺失阻断 |
| deadline/截止提交 | `customer_demands.submission_deadline_at` | 流程时限、企微发送 | 提交截止时间 | 必填，缺失阻断 |
| 单账号预算/报价上限 | `customer_demands.budget_max_cents` | 硬筛 | 报价 | 需展示单位元 |
| 返点 | `customer_demands.rebate_min_rate` / `customer_demands.rebate_max_rate` | 硬筛/排序 | 返点 | 必填区间，未提需补充 |
| CPM | `requirements_json.performance_thresholds.*.cpm_max_cents` | 数据阈值 | CPM | 若库无字段，要求补库 |
| CPC | `requirements_json.performance_thresholds.*.cpc_max_cents` | 数据阈值 | CPC | 若库无字段，要求补库 |
| CPE | `requirements_json.performance_thresholds.*.cpe_max_cents` | 数据阈值 | CPE | 若库无字段，要求补库 |
| CTR | `requirements_json.performance_thresholds.*.ctr_min_rate` | 数据阈值 | CTR | Brief 提到则必须出现 |
| 阅读量/曝光量 | `requirements_json.performance_thresholds` 或平台账号指标列 | 数据阈值/排序 | 阅读量/曝光量 | 需标明内容形式 |
| 互动率/互动量 | `requirements_json.performance_thresholds` 或平台账号指标列 | 数据阈值/排序 | 互动率/互动量 | 需标明口径 |
| 完播率 | `requirements_json.performance_thresholds` 或平台账号指标列 | 数据阈值/排序 | 完播率 | 视频场景使用 |
| 有效评论/评论真实 | `requirements_json.filter_rules` 或人工复核项 | 软匹配/人工复核 | 有效评论说明 | 模糊表达需追问 |
| 账号类型 | `creator_type_requirements` | 软匹配/召回 | 账号类型 | 不默认硬筛 |
| 内容方向/调性 | `content_requirements`、`tone_requirements` | 向量召回/排序 | 内容方向 | 模糊时追问 |
| 是否含税/开票 | `requirements_json.commercial_terms` 或回填明细 | 提报交付 | 是否含税/是否可开票 | Brief 提到则必须出现 |
| 档期 | `requirements_json.schedule_requirements` 或 offer 字段 | 可执行性 | 可执行档期 | 需 MCN 回填 |

## 生成表单流程

1. 读取 `validate_requirement` 返回的结构化 brief 和 `requirements_json`。
2. 抽取所有数据指标、商业条款、执行要求和回填所需字段。
3. 对照 `xhs_creator_accounts` / `dy_creator_accounts` 字段能力：已有字段进入表单；缺字段列为“需媒介/采购补充”。
4. 输出表单字段表，停下询问媒介是否增减字段。
5. 媒介确认后，才允许进入企微发送确认。

## 禁止

- 不得用固定模板覆盖所有需求。
- 不得遗漏 brief 中已确认的数据指标。
- 不得把数据库没有的字段伪造成已支持。
- 不得在表单字段未确认时调用 `create_with_distributions`。
