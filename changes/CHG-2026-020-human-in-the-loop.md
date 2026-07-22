# CHG-2026-020：统一 Human-in-the-loop 与自动续接

```yaml
task_id: CHG-2026-020-HUMAN-IN-THE-LOOP
change_type: skill-and-runtime-orchestration
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1"
approval_basis: "用户要求根据真实执行日志收敛提问，并明确只有 AskUserQuestion 才能形成会话级人工等待"
baseline: "e5bca71"
rollback_strategy: "回退本变更文件；不重放、不删除任何 Provider 写入"
```

## Decision

1. 会话级人工输入统一由原生 `AskUserQuestion` 承载；普通回复不得用“继续吗”“要怎么推进”或下一步菜单暂停流程。
2. 仅在缺少不可推断的必填/歧义业务值、基于真实证据的业务分支、不可逆企微外发或非确定性安全恢复选择时提问。可选值缺失、已明确值、可唯一换算值、平台处理顺序和确定性下一步都不得提问。
3. 同一轮需求澄清必须一次问全。已提交答案就是执行命令，立即在同一 assistant turn 继续；不得只回复确认，也不得要求用户再输入“继续”。取消、关闭或超时则停止，且不执行后续业务写入。
4. 多平台 Brief 按原文首次出现顺序拆成独立需求；不得询问先处理哪个，也不得在完成其中一个平台后询问是否继续剩余平台。所有平台复用同一完整 `originalBrief`。
5. `waiting_for="user"` 表示应立即打开对应 `AskUserQuestion`，或用户已经明确选择暂停并补充新业务输入；它不授权普通文本提问。网页字段选择是 Tool 自身 callback，不得再叠加聊天确认。
6. Tool 结果与本地证据投影冲突时不得宣称成功。确定性参数修复自动同轮完成；不可恢复或集成阻塞只报告并停止，不索要“继续”。

## Task Boundary

```yaml
goal: "把所有会话级人工等待收敛到 AskUserQuestion，并让确定性工作流与多平台剩余链路自动续接"
allowed_paths:
  - "changes/CHG-2026-020-human-in-the-loop*.md"
  - "spec/skills.json"
  - "spec/workflow.json"
  - "spec/hooks.json"
  - "YPmcn/src/index.ts"
  - "YPmcn/src/runtime-hook-workflow.ts"
  - "YPmcn/skills/media-assistant/**"
  - "YPmcn/tests/**"
  - "tests/spec_governance.test.mjs"
  - "tests/test_skill_package.py"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
forbidden_paths:
  - ".env*"
  - "packages/releases/**"
  - "remote Provider data"
acceptance:
  - "普通回复不再要求用户输入继续、确认下一步或选择平台顺序"
  - "只有正式 HITL 门禁调用 AskUserQuestion；需求缺项同一弹窗一次问全"
  - "AskUserQuestion 提交后同轮执行，取消时无后续业务写入"
  - "多平台 Brief 注入按原文顺序拆单且不得询问先处理哪个的权威提示"
  - "字段网页 callback 不产生重复聊天确认"
verification:
  - "npm run test:fast"
  - "npm run verify"
  - "git diff --check"
rollback: "回退本变更文件；不操作远程需求、询价或分发记录"
```

## External Boundary

当前 Host 没有 assistant-output Hook，无法用代码硬拦普通文本问句；本变更通过正式 Skill 契约、系统提示和回归测试收敛模型行为。企微外发的一次性参数指纹确认仍由 `before_tool_call` 硬门禁，不因本变更弱化。

## Verification Result

- `npm run test:fast`：75 项通过。
- Skill quick validator：通过。
- `npm run verify`：通过（最终文档同步后复验）。
- `git diff --check`：通过。
- 独立前向审阅发现多平台共享数量可能被按平台重复提问；契约已收敛为同一弹窗中的一个共享问题，并由回归测试覆盖。
- 未调用生产 Provider，未执行真实需求创建、询价或企微外发。
