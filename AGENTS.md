# Codex 项目执行准则

## 适用范围

- 本文件约束 Codex 在本仓库中的执行行为。
- Git 根目录是唯一长期项目；`YPmcn/` 和 `vector-mcp/` 是仓库组件。
- Claude Code 负责定义任务边界、选择执行角色、独立验证、最终验收和提交；Codex 不承担这些编排职责。

## 契约与优先级

- 正式契约以 `spec/manifest.json` 的 `contracts` 映射为唯一入口，不得绕过 manifest 自行选择或遗漏 Spec。
- 规则优先级：安全与数据完整性 > 正式 Spec > 本文件的角色硬限制 > 任务 acceptance 与 verification > 测试 > 当前实现 > Agent 推断。
- 公开 Tool、字段、错误码、权限、迁移或不可逆副作用不明确时，返回 `BLOCKED`，不得自行发明契约。

## 任务输入

执行前确认任务已明确提供：

```yaml
goal: "单一可观察结果"
allowed_paths: ["允许修改的路径"]
forbidden_paths: ["禁止修改的路径"]
acceptance: ["二元、可验证的完成条件"]
verification: ["必须运行的最小相关验证"]
```

任一关键边界缺失且无法从正式 Spec 或仓库事实确定时，停止并返回唯一阻塞项，不扩大范围猜测。

## Codex 角色与边界

- 你是当前任务的唯一 Executor；单个任务只允许一个写者和一个 worktree。
- 只修改完成目标必需且位于 `allowed_paths` 内的文件，不顺手重构、弱化测试或修复无关问题。
- 不自行拆分并启动其他写者，不调用 OpenCode，不把自测描述为独立验证。
- 不负责最终验收和提交；完成后向 Claude Code 交付修改、自测结果和风险。
- 不创建任务状态机、事件日志、JSONL 或持久化验证证据文件，除非任务明确把它们列入 `allowed_paths` 和 acceptance。

## 修改规则

- Bug 修复优先先复现，再做最小修复并运行相邻测试。
- 普通文档、测试和内部实现修复不要求 Change Proposal 或 Impact Analysis。
- 不直接编辑生成的 `dist/`、`packages/.staging/` 或 tgz。
- 不记录客户 Brief、完整 payload、凭据或未脱敏内部状态。
- 同类工具故障第二次出现时停止重试，改走最短可行路径或报告唯一阻塞项。
- 测试未运行必须标记 `NOT RUN`；失败不得描述为通过。

## 验证规则

默认运行：

```text
任务指定的相关测试
+ git diff --check
+ 修改范围检查
```

按修改范围追加验证：

- 日常运行逻辑：`npm run test:fast`。
- Plugin、Skill、manifest 或 OpenClaw 适配：必须运行 `npm run test:openclaw`。
- 跨组件改动或任务明确要求的合并前联调：运行 `npm run test:headless`。
- 发布候选：才运行 `npm run pack:yp` 并进入 YP Action UI 冒烟。
- 仅当风险、失败证据或任务要求需要时运行一次 `npm run verify`。
- 人类文档同步使用 `npm run docs:sync`；检查使用 `npm run verify:docs`。
- 生产 provider 独立只读检查使用 `npm run verify:provider`。

Headless 测试必须使用隔离配置，不得读取或修改 YP Action 正式用户配置，不得调用生产写 Tool；失败时保留首个协议或装载错误，不用 UI 重试掩盖。

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

## 远程 MCP 开发机

- 局域网：`ssh 26969@192.168.0.129`
- Tailscale：`ssh 26969@100.82.209.65`
- Windows MCP server 项目：`D:\yp_local_mcp`
