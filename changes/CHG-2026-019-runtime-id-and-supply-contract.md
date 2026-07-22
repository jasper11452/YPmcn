# CHG-2026-019：修复需求主键、Brief 绑定与搜索供给契约

```yaml
task_id: CHG-2026-019-RUNTIME-ID-AND-SUPPLY-CONTRACT
change_type: runtime-hook-and-tool-contract
status: IMPLEMENTED_LOCAL_HOST_BLOCKED
approved_spec_version: "mvp-v2 / MCP schemaVersion 1 / Hook schemaVersion 6"
approval_basis: "用户要求根据失败日志与既往修复内容制定并实施插件侧修复"
baseline: "6ba43e8"
rollback_strategy: "回退本变更；不清理、不重放远程已创建的需求或搜索事实"
```

## Decision

1. `validate_requirement.data.id` 是 `search_creators.id` 与 `manual_source_creators.requirement_id` 的唯一 Tool 主键；数字型 `data.demand_id` 和 `demand_version` 仅是业务标识，不得混用。
2. 主键格式错误在 Provider 调用前拒绝，并从既有验证响应纠正，不得再次执行 `validate_requirement`。
3. 手扒授权必须绑定同一宿主会话的一次性验证回执；当前宿主若未向 `before_tool_call` 传递会话上下文，则明确返回 `INTEGRATION_REQUIRED`，禁止退回全局状态授权或重复建单。
4. `rawMessagesJson.originalBrief` 必须等于 Hook 捕获的完整原始 Brief；禁止添加重试标记或按平台重写。多平台拆单共享同一完整 Brief，其余平台条件进入审计 atom。
5. `search_creators` 以 `total_matched + supply_assessment` 为主响应；仅 3.4.9 兼容旧三字段形状，并记录实际消费的契约。新旧结构冲突时停止。
6. 明确“继续手扒”的续接意图优先走手扒；一般新需求验证后默认走搜索。用户澄清统一为最多 5 问、每问 2–6 项，且不展示内部价格字段名。

## Task Boundary

```yaml
goal: "阻止 ID 命名空间混用、重复建单、Brief 篡改和搜索响应误读，并让缺失宿主上下文时安全停止"
allowed_paths:
  - "changes/CHG-2026-019-runtime-id-and-supply-contract*.md"
  - "spec/**"
  - "YPmcn/src/**"
  - "YPmcn/tests/**"
  - "YPmcn/skills/media-assistant/**"
  - "YPmcn/README.md"
  - "YPmcn/.codex-plugin/plugin.json"
  - "YPmcn/.claude-plugin/plugin.json"
  - "YPmcn/openclaw.plugin.json"
  - "YPmcn/package*.json"
  - "package*.json"
  - "tests/**"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
forbidden_paths:
  - ".env*"
  - "packages/releases/**"
  - "remote Provider data"
acceptance:
  - "search/manual 只接受 32 位 data.id，数字 demand_id 在本地拒绝且不触发重新验证"
  - "缺失 before_tool_call 会话上下文时手扒明确阻断并等待宿主升级"
  - "多平台 payload 保持同一个完整 originalBrief，篡改或加前缀会被拒绝"
  - "当前搜索响应正确判定 500/10 与 63/10，旧结构仅保留一版兼容且冲突时停止"
  - "显式继续手扒不会被误路由到搜索"
verification:
  - "npm run test:fast"
  - "npm run verify"
  - "git diff --check"
rollback: "回退本变更文件；不得删除现存远程重复需求"
```

## External Boundary

插件不拥有宿主 Hook 上下文传递与 Provider 数据清理。当前宿主未向 `before_tool_call` 暴露会话标识时，手扒保持安全阻断；修复该宿主集成后，现有同会话回执逻辑即可放行。日志中已经产生的重复需求不在本次授权范围内，不做删除或合并。

## Verification Result

- `npm run test:fast`：通过，72 项插件测试通过。
- `npm run verify`：通过，Spec、自动文档、安装与安全门禁、72 项插件测试、Provider 比较器离线测试、Skill 契约及 3.4.9 可复现包内容检查全部通过。
- `git diff --check`：通过。
- 已生成 `packages/releases/ypmcn-media-assistant-3.4.9.tgz`（117940 bytes，SHA-256 `61fb9b4bf40e9e1009599f15c413bc3df841b2e2ea27e673b21685a7e9c2fbb2`），发布包安全扫描通过。
- 未执行生产写入或远程重复需求清理。
