# 需求字段边界

当前生产 `validate_requirement` 只接收原始消息和可选上下文。需求解析由 MCP 完成，Agent 不发送 `parsed_requirement`。

`requirement_parsed` 必须按 `customer_demands` 字段语义返回，而不是只返回当前链路少量展示字段。客户需求表是筛选、向量召回、排序和企微分发的事实源。

## Ready 阻断字段

缺少以下任一条件时 `status=draft`，不得继续 `search_creators`：

- `platforms`
- `quantity_total`
- `submission_deadline_at`
- `content_requirements` 或 `budget_max_cents`/单价条件至少一个

以上只是允许继续 `search_creators` 的最低 ready 条件，不是 `requirement_parsed` 的字段抽取上限；客户原文里的其他需求仍必须按下文规则结构化保留。

`submission_deadline_at` 必须是可执行的截止提交时间；相对时间必须依赖原始消息 `sent_at`，无法解析时保留 `submission_deadline_raw` 并把 `submission_deadline_at` 放入 `blocking_fields`。

返点不是 ready 阻断字段；客户没有返点要求时不要为了继续流程而编造 `rebate_min_rate`。

## `customer_demands` 对齐

MCP 输出应覆盖客户需求表中可落库的字段，包括：

- `project_name`、`brand`、`product`
- `platforms`
- `content_formats`、`cooperation_types`
- `submission_deadline_at`、`submission_deadline_raw`
- `budget_min_cents`、`budget_max_cents`、`budget_raw`
- `rebate_min_rate`、`rebate_max_rate`、`rebate_raw`
- `quantity_total`
- `category_requirements`
- `creator_type_requirements`、`creator_tier_requirements`
- `follower_min`、`follower_max`
- `geo_requirements`、`audience_requirements`
- `content_requirements`、`tone_requirements`
- `negative_requirements`
- `requirements_json`

`raw_messages` 中出现的客户要求应优先映射到上述 `customer_demands` 对应字段；没有独立字段或当前硬筛能力不足的要求，必须落入 `requirements_json`，用于后续向量召回、排序、推荐理由或人工复核，不能因为暂时无法硬筛而丢弃。

## 筛选语义

数字或数据阈值进入硬筛：单价、预算、粉丝量、数量、CPM、CPE、互动量、完播率、曝光量、点赞量等应标准化进独立字段或 `requirements_json.performance_thresholds` / `filter_rules`。

类型、内容、调性、参考账号进入向量召回和排序：账号类型、内容方向、达人风格、参考链接、参考账号、文案调性等保留到 `content_requirements`、`creator_type_requirements`、`tone_requirements`、`requirements_json.reference_materials` 等字段，参与向量搜索、软匹配和推荐理由。

类目默认不是硬筛。不因类目不匹配淘汰候选，除非客户原文明确“只要/必须/不要其他类目”，且后端规则显式写入可执行 `filter_rules[].mode=hard` 并取得媒介确认。

## Agent 负责

- 保留客户/媒介原文与真实消息角色。
- 在首次调用前以文本形式（`pre-validate-requirement` 模式）向用户核对运行时 schema 和拟传参数。
- 不确定的业务事实留在原文中，不自行补值。
- 读取 MCP 返回的 `requirement_parsed`、`missing_fields`、`blocking_fields`、`clarifying_questions`。
- 面向用户展示短摘要，不泄露完整结构化对象。

## MCP 负责

- 平台、内容/单价、数量、截止日期、数据阈值和其他条件的解析与归一。
- 证据一致性、字段完整性和业务规则校验。
- `draft`/`ready` 判定、需求 ID/版本和数据库写入。

## 禁止

- 请求体中添加 `parsed_requirement` 或 `parsed_requirement_draft`。
- 把 Agent 推断写进 `raw_messages` 并标成 `client`/`media`。
- 为满足必填而编造平台、内容、预算、数量、截止日期、ID 或版本。
- 用业务调用试错探测 schema。
- 因本地旧 reference 与运行时 schema 冲突而继续调用。

运行时 schema 变化时，以当前 `tools/list` 为准；先以文本形式向用户报告差异并确认，再构造新请求。
