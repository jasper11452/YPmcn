# Codex 项目执行准则

## 工作流程

- 定位问题关联的内容
- 提出修复方案
- 拆解修复行动
- 调用opencode，并行启动多个session执行修复(OPENCODE_DISABLE_EXTERNAL_SKILLS=1 opencode run --auto --pure -m yuepu/Deepseek-V4-Flash --variant max "</prompt>")
- 验证修复结果

## 适用范围

- Git 根目录是唯一长期项目；`YPmcn/` 是可发布组件，向量能力由远程服务负责。

## 契约与优先级

- 正式契约以 `spec/manifest.json` 的 `contracts` 映射为唯一入口，不得绕过 manifest 自行选择或遗漏 Spec。
- Tool 与工作流分别以 `spec/mcp.json`、`spec/workflow.json` 为准。
- 规则优先级：安全与数据完整性 > 正式 Spec > 本文件的角色硬限制 > 任务 acceptance 与 verification > 测试 > 当前实现 > Agent 推断。
- 公开 Tool、字段、错误码、权限、迁移或不可逆副作用不明确时，不得自行发明契约。
- 离线运行 `npm run verify`；生产 provider 只读检查运行 `npm run verify:provider`，`uv` 与 `reference-mcp` 结果不得冒充生产证据。

## 任务输入

执行前明确任务要求：

```yaml
goal: "单一可观察结果"
acceptance: ["二元、可验证的完成条件"]
verification: ["必须运行的最小相关验证"]
```

## 修改规则

- 做最小修复并运行相邻测试。
- 同类工具故障第二次出现时停止重试，改走最短可行路径或报告唯一阻塞项。
- 测试未运行必须标记 `NOT RUN`；失败不得描述为通过。
- `pre-commit` 会同步人类文档；手动使用 `npm run docs:sync`，只读检查使用 `npm run verify:docs`。

## YPmcn 不可放宽的硬门禁

1. 不得跳过正式 Spec 定义的 14 阶段工作流。
2. `create_with_distributions` 前必须完成 supply、MCN、message 三项确认，并通过 `confirm_distribution_send` session action 写入。
3. `recovered` 或 `closed` 终态后不得重复写入。
4. 只有实际 MCP 返回可作为成功证据，不得用预期返回或示例 JSON 模拟成功。
5. 下游 ID 无法从实际返回证明时，停止并返回 `integration_required`，不得自行生成。
6. 禁止通过 shell、curl 或 PowerShell 绕过 provider 写 Tool。

## 交付格式

只返回：

```text
结果：完成 / 阻塞
改动：changed files 与一句话说明
验证：命令与 PASS / FAIL / NOT RUN
风险：无或具体风险
```

不得声称已完成独立验证或最终提交。
