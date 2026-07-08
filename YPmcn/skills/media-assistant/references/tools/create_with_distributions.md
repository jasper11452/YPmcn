# create_with_distributions

## 何时调用

结构化 brief、MCN/野生比例、MCN名单、表单字段、企微角色权限、发送对象、发送内容、表单链接和群都已确认后调用。

## 输入

以运行时 schema 为准，必须包含未来的带时区 ISO 8601 `deadline` / `remindAt`，以及后端要求的项目和供应商分发字段。

推荐按运行时 schema 选择以下两种形态之一：

```json
{
  "projectName": "618达人提报",
  "description": "请在截止时间前完成达人信息填写。",
  "deadline": "2026-07-07T18:00:00+08:00",
  "usageScope": "project",
  "platform": "小红书",
  "supplierIds": ["supplier-id"],
  "sendWechatNotification": true
}
```

或：

```json
{
  "project": {
    "projectName": "618达人提报",
    "description": "请在截止时间前完成达人信息填写。",
    "deadline": "2026-07-07T18:00:00+08:00",
    "usageScope": "project",
    "platform": "小红书"
  },
  "supplierIds": ["supplier-id"],
  "sendWechatNotification": true
}
```

`usageScope: "project"` 是唯一固定值，不要让模型选择其他枚举；漏传时 hook 会补，显式传错会阻断。`columns`、`templateId`、`notification_template` 等字段按运行时 schema 和用户确认结果传，不由 hook 强制。

## 输出成功证据

项目创建、供应商分发和企微通知执行结果。成功后 Hook 进入等待锁，收到用户新消息前不得推进下一步。

## 调用后必须停在哪里

发送成功后停在等待回填/是否继续精排确认。发送失败时停在错误处理，不进入等待锁。

## 禁止

不得通过 Bash、PowerShell、curl 或旧工具名绕过。不得让模型控制 `endpointUrl`、`execute` 或发送模式。非媒介/采购角色不得调用。不得把 `usageScope` 写成 `项目`、`campaign`、`supplier` 或其他值。
