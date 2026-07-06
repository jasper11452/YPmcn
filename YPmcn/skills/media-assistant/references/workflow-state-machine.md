# 流程与恢复

当前生产 MCP 没有 `get_workflow_state`，基础响应也不要求 `workflow_state` 或 `allowed_actions`。因此 Agent 不维护或伪造一套独立权威状态机，只保留从成功响应获得的最小 ID 和业务阶段摘要。

## 最小会话索引

只记录已由 MCP 成功返回的字段：

```json
{
  "provider_binding": "YPmcn",
  "phase": "requirement|candidate_pool|mcn_planning|ranking|submission|feedback",
  "demand_id": null,
  "demand_version": null,
  "run_id": null,
  "project_distribution_completed": false,
  "inquiry_ids": [],
  "last_tool": null,
  "last_trace_id": null,
  "last_error": null
}
```

这只是恢复索引，不覆盖 MCP/数据库事实。

## 阶段推进

| 阶段 | 进入证据 | 下一业务动作 |
|---|---|---|
| requirement | `validate_requirement` 成功 | draft 时澄清；ready 且用户确认后搜索 |
| candidate_pool | `search_creators` 成功 | 按平台 `rank_mcns` |
| mcn_planning | `rank_mcns` 成功 | 停止，展示比例、MCN 机构、企微消息，询问是否发送 |
| distribution | `create_with_distributions` 成功 | 停止，询问是否调用 `rank_creators` 精排 |
| ranking | `rank_creators` 成功并返回 `run_id` | 生成提报批次 |
| submission | `create_submission_batch` 成功 | 等客户反馈 |
| feedback | `record_client_feedback` 成功 | 按 `next_action` 路由 |

不得仅因“通常下一步如此”就跳过所需成功证据。

## 人工确认

所有 Agent 层暂停点统一使用 `AskUserQuestion`，不再使用自由文本对话。完整模式定义见 [AskUserQuestion 模式](ask-user-question-patterns.md)。

| 暂停点 | AskUserQuestion 模式 | 决策 | 下一动作 |
|---|---|---|---|
| 首次业务调用前 | `pre-validate-requirement` | 确认目标工具、必填字段、拟传值 | 调用 `validate_requirement` |
| status=draft | `requirement-draft` | 用户提供补充信息 | 携带补充消息重新调用 |
| rank_mcns 成功后 | `mcn-wechat-send` | 是否发送企微询价 | 调用 `create_with_distributions` |
| create_with_distributions 成功后 | `proceed-to-ranking` | 是否进入达人精排 | 调用 `rank_creators` |
| 中风险 MCN | `confirm-medium-risk` | 接受中风险继续 | 调用 `rank_mcns`（medium_risk_confirmed=true） |
| 风险账号提报 | `confirm-risky-submission` | 接受风险账号 | 调用 `create_submission_batch`（allow_need_confirm_with_risk=true） |
| 用户修改需求 | `requirement-modify` | 确认重新校验 | 重新调用 `validate_requirement` |
| 供给不足 | `insufficient-supply` | 补量/放宽/继续 | 按选择调用对应工具 |

- 每个 AskUserQuestion 调用前，Agent 先给一句简短结论（当前阶段结果 + 需要用户决策什么）。
- 用户选择「确认/继续」类选项后，Agent 立即执行对应业务动作，不二次询问。
- 用户选择「取消/拒绝」后，Agent 停止，不得自动推进。
- `AskUserQuestion` 处理「用户想怎么做」；hook 层 `requireApproval` 处理「系统允不允许」。两者独立，不可互相替代。

## 项目分发等待

调用 `create_with_distributions` 前必须取得单次用户确认，并提供未来的 `deadline` / `remindAt`。不得通过 Bash、脚本或 `/api/projects/create-with-distributions/` curl 直连。调用成功后只记录企微询价已发送并进入等待态；当前不创建 Cron/提醒任务。收到用户新消息前不得执行下一步。

调用失败不进入等待锁，不允许自动推进。

## 恢复

1. 有 `run_id`：调用 `get_recommendation_run_detail`，核对 run、批次和反馈。
2. 有平台账号：用 `get_creator_detail` 核对达人详情。
3. 只有 `demand_id/demand_version`：当前没有状态查询工具；不要调用不存在的 `get_workflow_state`，按最近成功业务响应继续，证据不足则停止。
4. 写调用超时或断连：当前请求 schema 没有幂等键，不得自动重试。若已取得 `run_id` 用详情查询；否则用 `trace_id` 请后端查证。
5. 用户修改需求：携带原始补充消息重新调用 `validate_requirement`；旧 ID/版本只按运行时 schema 和后端返回使用。

## 可选状态扩展

若未来 provider 实际返回 `workflow_state`/`allowed_actions`：

- 只把它们作为该 provider 的附加证据。
- `allowed_actions` 存在时遵守白名单。
- `pending_gate` 存在时按运行时 schema 找到真实确认字段；找不到则走 YP Action 审批并报告 `integration_required`，不猜字段。
- 扩展缺失不构成基础响应错误。

## 失败条件

- 工具不存在、schema 冲突、ID 来源不明、响应基础信封破损或业务成功证据不足时立即停止。
- 不重复写、不模拟成功、不基于残缺结果推进。
- 面向用户只展示简短阻断原因和所需下一步，完整 `trace_id` 仅用于明确排障。
