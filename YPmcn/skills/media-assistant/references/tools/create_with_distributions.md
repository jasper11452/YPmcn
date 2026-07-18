# create_with_distributions

## 何时调用

供需、目标 MCN、消息和字段准备完成，且 `get_workflow_state` 允许外发时调用；这是不可逆的外部项目与分发写入。

## 输入

必填 `projectName`、`deadline`、`columns`、`supplierIds`、`prefillRows`、`prefillRowsBySupplier`；可选 `description`、`usageScope`。

## 输出成功证据

- retain actual returned payload as downstream evidence
- `success=true`，并返回可对账的项目或 distribution 身份
- 返回更新后的 `workflow_state` 与 `allowed_actions`

## 调用后必须停在哪里

外发前没有 10 分钟内同项目的成功 `get_workflow_state`，或最新 `allowed_actions` 未授权时，Hook 先阻断。通过状态门禁后，首次调用返回 `YP_CONFIRMATION_REQUIRED`；Ask 必须原样展示返回的请求摘要与固定企微模板 ID/hash，完成一次性确认后以完全相同参数重试。成功后按返回身份调用 sync；结果未知则先 `get_workflow_state`。

## 能力边界

下游外部 API 原始文档显示：它在一个事务中创建 project 与 distributions，支持 `notification_template`、`supplierIds`、全局/分机构预填，并会返回 project/distribution 身份；同一已有 project 的重复 supplier 会跳过，但整个创建请求超时重放仍可能重复建 project。这是下游 API 能力，不等于当前 MCP 已广告所有字段。

本 Tool 只调用外部 API，不写本地 `mcn_inquiries`；询价镜像必须由后续 `sync_mcn_inquiry_status` 独占，避免两个 Tool 争写。待部署后端路由已接受并原样传递 `notification_template`，但当前远程 `tools/list` 未重新取证；live schema 未声明时固定企微消息仍只能预览，不能声称已发送。

固定消息从 `../../assets/wecom_inquiry_template.txt` 渲染；不得自由改写标签或顺序。只有品牌/产品行允许在没有事实时整行省略。渲染值必须来自已保存需求和本轮确认的 columns，不能由 Agent 补写。

幂等必须在 MCP 服务端复用 `mcp_tool_call_ledger`，不能靠本地确认凭证代替。外部 API 在支持稳定 `clientRequestId`/`Idempotency-Key` 或按该键查询前，网络超时只能记为 `unknown` 并人工/查询对账，禁止盲重发。

## 错误与停止条件

不得发送 live schema 未声明的 `notification_template`、旧 `mcn_recommendation_id`、`remindAt`、`sendWechatNotification` 或 `preview_only`。Ask 修改、Reject、超时、参数变化或写结果未知时不得发送。
