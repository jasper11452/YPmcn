# create_with_distributions

## 何时调用

结构化 brief、MCN/野生比例、MCN名单、表单字段、企微角色权限、发送对象、发送内容、表单链接和群都已确认后调用。

## 输入

以运行时 schema 为准，必须包含 `id`（来自 `rank_mcns.data.id` 的 MCN 排序方案 ID）、未来的带时区 ISO 8601 `deadline` / `remindAt`、`supplierIds` / `supplier_ids`，以及后端要求的项目和供应商分发字段。企微发送接口字段固定，不得为了业务说明自造输入输出字段。

推荐按运行时 schema 选择以下两种形态之一：

```json
{
  "id": "mcn_plan_id",
  "projectName": "618达人提报",
  "description": "请在截止时间前完成达人信息填写。",
  "deadline": "2026-07-07T18:00:00+08:00",
  "usageScope": "project",
  "platform": "小红书",
  "supplierIds": ["supplier-id"],
  "sendWechatNotification": true,
  "prefillRowsBySupplier": {
    "supplier-id": [
      {"talentName": "达人A", "price": 200000}
    ]
  }
}
```

或：

```json
{
  "id": "mcn_plan_id",
  "project": {
    "projectName": "618达人提报",
    "description": "请在截止时间前完成达人信息填写。",
    "deadline": "2026-07-07T18:00:00+08:00",
    "usageScope": "project",
    "platform": "小红书"
  },
  "supplierIds": ["supplier-id"],
  "sendWechatNotification": true,
  "prefillRowsBySupplier": {
    "supplier-id": [
      {"talentName": "达人A", "price": 200000}
    ]
  }
}
```

`id` 只能来自 `rank_mcns.data.id`，不得用需求表 ID 或候选池 ID 代替。`usageScope: "project"` 是首选固定写法，不要让模型选择业务枚举；接口文档里的 `项目` 会被 hook 兼容归一为 `project`，漏传时 hook 会补，其他显式值会阻断。`columns`、`templateId`、`notification_template`、`prefillRows`、`prefillRowsBySupplier` 等字段按运行时 schema 和用户确认结果传，不由 hook 强制。

每个 MCN/供应商必须有唯一填报链接；链接或 token 由后端分发响应产生，Agent 不自己拼。`prefillRowsBySupplier` 只放候选池中属于当前 MCN/供应商的达人，作为机构填报表的推荐底稿。

## 输出成功证据

项目创建、供应商分发、每个 MCN 的唯一填报链接/令牌和企微通知执行结果。成功后 Hook 进入等待锁，收到用户新消息前不得推进下一步。

## 调用后必须停在哪里

发送成功后停在等待机构回填和手扒结果回收到候选池。发送失败时停在错误处理，不进入等待锁。

## 禁止

不得通过 Bash、PowerShell、curl 或旧工具名绕过。不得让模型控制 `endpointUrl`、`execute` 或发送模式。非媒介/采购角色不得调用。除后端文档兼容的 `项目` 外，不得把 `usageScope` 写成 `campaign`、`supplier` 或其他值。不得把不属于当前 MCN/供应商的达人预填给该 MCN。
