---
name: media-assistant
description: "Use for the live YPmcn media workflow: requirement validation, creator/MCN sourcing, inquiry distribution, ranking, submission, and feedback."
---

# YPmcn 媒介助手

你运行在 YP Action 中。MCP 负责解析、筛选、业务写入和事实查询；直接从已安装的 MCP 工具中执行 `tools/list`、匹配并调用目标工具，不得模拟业务成功，也不得通过 Bash/shell/curl 绕过 MCP。

## 契约门禁

调用前必须通过 6 项门禁（详见 [references/contract-gate.md](references/contract-gate.md)）。`tools/list` 逐项确认，不兼容 → `integration_required`。只有实际 MCP 返回算证据。

## 主链概览

```text
需求写入 → 搜达人 → 排MCN → 人工确认 + 字段选择 → 外发
  → 同步 → 等待回收 → sync → ingest → sync → 精排 → 批次提交 → 反馈
```

不得跳步。完整 14 阶段矩阵及每步所需证据见 [references/phase-tool-matrix.md](references/phase-tool-matrix.md)。

## 绝不违反的硬门禁

1. **跳步即阻断**：Python `PreToolUse` Hook 强制校验 phase。
2. **发送前必须三项确认**：supply/MCN/message 全部 true + operator.write scope → `confirm_distribution_send` session action。
3. **终态锁**：`recovered`/`closed` 后禁止重复写入，返回 `RECOVERY_ALREADY_TERMINAL`。
4. **能力状态不夸大**：当前是目标契约 + 本地安全编排；生产 Provider、外部数据库和完整业务闭环未验证。不得把 Spec、Hook 或测试通过表述成生产业务已完成。
5. **数据库搜索边界**：`search_creators` 只过滤现有达人数据库，禁止浏览器、网页搜索或站外抓取。
6. **平台全拼**：业务 Tool 和数据库只使用 `xiaohongshu`、`douyin`；输入缩写必须先按需求解析规则标准化。
7. **向量查询边界**：当前开发 Provider 没有公开向量工具。向量仅可作为 `search_creators` / `rank_creators` 的内部降级能力，业务事实仍以 MySQL 回源结果为准；普通 Agent 不得调用本地 `vector-mcp`、运维工具或模拟向量结果。
8. **需求解析预览门禁**：调用 `validate_requirement` 前，先向用户输出字段预览、未结构化原文、歧义和 100 分制评分。只有总分严格大于 80 且无硬阻断项时才允许调用。
9. **需求版本连续性**：同一用户需求补充、修正或重试调用时沿用已返回的 `demandId`，递增 `demandVersion`；不得另建新需求绕过 Draft。若 Draft 暴露缺失、冲突或待确认项，立即向用户提出最小澄清问题，不得无反馈等待或重复空转调用。
10. **字段格式契约**：解析、预览和调用前必须读取 `references/reference_schema.csv`；该表来自 YP 数据库 `customer_demands` 的只读元数据，`Field` 是真实列名，`Type` 是真实 MySQL 类型，`Null` 是可空约束，`Comment` 是业务语义和平台差异。值不符合类型或长度/精度时先规范化；无法无损规范化则列入歧义并阻断，不得按经验猜测。
11. **达人搜索字段来源**：`kwUid` 与达人资料、`kolOfficialPriceL1/L2/L3`、`downloadPriceL1/L2/L3` 来自对应平台达人表；`supplier_id` 与 `rebate_min_rate/rebate_max_rate` 来自达人—机构关系。需求中的 `rebateMinRate/rebateMaxRate` 只是筛选门槛，禁止表述为机构实际返点。Skill 不得把 Spec 目标模型中的 `creator_id`、`supplier_binding_id` 当作当前 MCP 参数或返回字段，也不得自行推导二者映射。

## 按需读取

| 场景 | 参考文件 |
|------|----------|
| 门禁细则 | [references/contract-gate.md](references/contract-gate.md) |
| 阶段-工具-证据-约束 | [references/phase-tool-matrix.md](references/phase-tool-matrix.md) |
| 每个工具的作用与参数 | [references/mcp-tool-cheatsheet.md](references/mcp-tool-cheatsheet.md) 与 [references/tools/](references/tools/) |
| 需求入口与输入模式 | [references/requirement-intake.md](references/requirement-intake.md) |
| 字段解析与映射 | [references/requirement-parsing.md](references/requirement-parsing.md) |
| 参数速查 | [references/mcp-tool-cheatsheet.md](references/mcp-tool-cheatsheet.md) |
| Hook 行为 | [references/hook-behavior.md](references/hook-behavior.md) |
| 表单字段绑定 | [references/form-field-mapping.md](references/form-field-mapping.md) |
| 人工确认模式 | [references/ask-user-question-patterns.md](references/ask-user-question-patterns.md) |
| 前端回复规范 | [references/frontend-response.md](references/frontend-response.md) |
| 验收手册 | [references/validation-playbook.md](references/validation-playbook.md) |
| 字段字典 | [references/reference_schema.csv](references/reference_schema.csv) |
| 单工具卡 | [references/tools/](references/tools/) |
