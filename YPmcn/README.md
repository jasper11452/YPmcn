# YPmcn 媒介助手插件

YP Action/OpenClaw 插件，按 `mvp-v2` 机器契约执行达人提报链路。插件对每次拓展达人绑定当次新需求 ID，并对不可逆企微外发做本地硬确认；业务结果仍由 MCP/Provider 提供。

## 完整链路

```text
select_inquiry_form_fields(platform) → 网页选择字段
→ validate_requirement(payload) → 取得本次响应的 32 位 data.id
→ manual_source_creators(requirement_id, size)
→ rank_creators(requirement_id, inquiry_ids?) 筛选去重
→ create_submission_batch(requirement_id, size, number) 导出表格
```

`manual_source_creators` 可从任意既有阶段发起，但每次调用前必须重新解析完整需求并成功执行 `validate_requirement`；只允许把该响应的 32 位 `data.id` 用于紧邻的一次拓展达人，数字型 `data.demand_id` 和 `demand_version` 不是 Tool 主键。系统不查询该需求是否历史检索过，也不要求其他流程完成。Tool 只接收 `requirement_id` 与正整数十进制字符串 `size`。`rank_creators` 始终传当前 `requirement_id`；会话历史中没有企微发送返回的 `inquiry_id` 时省略 `inquiry_ids`（或传 `null`），有记录时按发送调用从新到旧选择第一个有效 ID，并以单元素数组传入。当前 production 在排序后会停在 `integration_required`：不调用入参不兼容的导出或恢复 Tool，也不猜测字段映射。

## Hook 边界

插件注册 `before_prompt_build`、`before_tool_call`、`after_tool_call`、`session_end`。

- Hook 按会话把本地 phase、next_action 和脱敏事件写入 `state/confirmation_guard.json`；实际 MCP 结果仍是业务事实证据。
- 需求 preview 只作为提示上下文，不形成通用 Tool 权限门禁；Skill、resources、prompts 和普通宿主工具均不被 Hook 阻断。
- Hook 对搜索和拓展达人校验 32 位 `data.id`；拓展达人还核对紧邻成功解析的一次性回执。若宿主未向 `before_tool_call` 传入会话上下文，则使用插件自有的全局一次性交接回执完成精确匹配与单次消费，不会再次建单。
- Hook 只保存完整客户 Brief 的短期哈希来拒绝重试前缀、静默改写和多平台拆单重构，不保存 Brief 正文。
- 本地 JSON 是 Agent 编排状态权威；除上述一次性拓展达人 ID 与企微外发确认外，Hook 不对普通 Tool 做严格顺序/参数阻断。Provider 状态仅用于业务事实和未知写对账。
- shell、PowerShell、curl 直连 provider 的企微外发接口会被阻断，避免绕过最终确认。
- 宿主未向企微外发 Hook 传入会话上下文时，首次调用仍生成本地确认；确认后只允许唯一、未过期、参数指纹完全匹配的一次性回执继续执行，多个匹配保持阻断。
- provider 发送调用会触发 Native Approval；Allow 由宿主继续同一待执行调用，Reject/超时/取消不触达 Provider。
- 参数变化、重放或未知写结果都必须产生新的 Native Approval；唯一例外是 Provider 明确无写入并指出未绑定机构时，只缩减这些机构的续发可继承原确认。
- Hook 不记录客户 Brief、消息正文或完整 payload。

## Provider 状态

开发与生产 profile 统一连接 `https://mcp.eshypdata.com/sse`。仓库保留的 15 个业务工具契约仍须通过当前 endpoint 的实时 `tools/list` 检查，不能把旧快照冒充实时结果。插件只接受搜索响应的 `total_matched + supply_assessment` 当前契约。拓展达人在宿主未向 `before_tool_call` 传递会话上下文时使用插件自有的一次性交接回执完成新鲜 ID 校验；当前 production 的 `create_submission_batch`（要求 `submission_batche_page` 与 `columns`）和 `get_workflow_state`（要求 `requirement_id`）都与批准契约不兼容，插件已硬阻断，直至 Provider 发布目标入参。

```bash
npm run mcp:dev
npm run verify:provider
npm run mcp:prod
npm run verify:provider:prod
```

发布包写入统一远程 SSE，包内不含 Vector MCP。YP Action/OpenClaw 已支持 SSE；`.codex-plugin/plugin.json` 通过 `mcpServers` 指向包内 `.mcp.json`。Codex 插件结构校验已通过，但“YP Action 在没有预存全局配置的全新环境安装 tgz 后自动注册 MCP”仍必须用干净安装环境验收，不能用手工 `mcp set` 代替。

## 开发与安装包

```bash
npm ci
npm test
npm run pack:yp
```

安装时使用生成的 `.tgz`，不要直接选择源码目录。安装后先确认远程 `ypmcn-mcp` 已被宿主注册，再运行真实 Live E2E；本地测试不能作为生产业务成功证据。

Agent 指令见 [skills/media-assistant/SKILL.md](skills/media-assistant/SKILL.md)。机器契约以根目录 `../spec/` 为准；发布包内 spec 由统一打包脚本生成。

`hooks/*.py` 只保留为历史状态机的确定性回归工件，不是当前 YP Action 执行面，也不会进入发布包；当前宿主实际运行的是 `src/runtime-hooks.ts` 注册的 Node Hook。
