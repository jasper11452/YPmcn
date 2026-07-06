# YPmcn OpenClaw Plugin

面向 OpenClaw 的"媒介助手"插件。Agent 只负责阶段路由、MCP 调用、人工 gate 和短回复；需求解析、筛选、排序、写入、版本校验与数据库事实查询全部由独立接入的 MCP 实现。

运行包包含：

- [OpenClaw 插件 manifest](YPmcn/openclaw.plugin.json)
- [入口路由 Skill](YPmcn/skills/media-assistant/SKILL.md)
- [需求入口](YPmcn/skills/media-assistant/references/requirement-intake.md)
- [需求结构化解析](YPmcn/skills/media-assistant/references/requirement-parsing.md)
- [MCP 工具路由](YPmcn/skills/media-assistant/references/mcp-tool-routing.md)
- [工作流状态机](YPmcn/skills/media-assistant/references/workflow-state-machine.md)
- [前端回复](YPmcn/skills/media-assistant/references/frontend-response.md)
- [Hook 行为](YPmcn/skills/media-assistant/references/hook-behavior.md)
- [验证手册](YPmcn/skills/media-assistant/references/validation-playbook.md)

插件无绝对路径、无内置 MCP Server。运行时 hooks 已在 `YPmcn/src/index.ts` 中实现并通过 OpenClaw Plugin SDK 注册；`SKILL.md` 保留相同约束作为 Agent 自检和语义说明。

`doc/客户原始需求列表.csv` 与 `tests/` 只用于仓库级验收，不进入安装包。

接入要求、12 个 Agent 工具和保密边界见 [插件说明](YPmcn/README.md)。

## 格式迁移

WorkBuddy → OpenClaw：

| 原 WorkBuddy | OpenClaw |
|---|---|
| `.workbuddy-plugin/plugin.json` | `openclaw.plugin.json` |
| `.workbuddy-plugin/hooks.json` (声明式 hooks) | `src/index.ts` 运行时 hooks：`before_tool_call`、`after_tool_call`、`tool_result_persist` |
| `skills/` + `references/` | 保留，用于 Agent 指令和业务语义说明 |

## 关联来源文档

仓库级验收依赖 `doc/客户原始需求列表.csv`、`tests/goldens/requirement_cases.json` 与 `tests/goldens/requirement_regressions.json`。数据库表、MCP 接口、MCP 验收标准与业务算法规则由项目私有文档维护，不写入插件运行包。
项目相关文档地址：/Users/jasper/Documents/YPmcn-skill/doc
