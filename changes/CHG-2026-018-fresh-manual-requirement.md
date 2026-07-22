# CHG-2026-018：拓展达人调用绑定当次新需求 ID

```yaml
task_id: CHG-2026-018-FRESH-MANUAL-REQUIREMENT
change_type: workflow-and-hook-contract
status: IMPLEMENTED_LOCAL_PROVIDER_UNVERIFIED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户明确要求拓展达人不受流程阶段限制，但每次调用前必须重新解析需求并使用当次生成的唯一新需求 ID"
baseline: "64b4878"
rollback_strategy: "回退本变更；远程已产生的需求、拓展达人、排序或导出事实只按 Provider 权威状态处置"
```

## Decision

1. `manual_source_creators` 不以当前 phase、历史检索记录或其他流程是否完成作为调用条件。
2. 每次拓展达人调用前必须重新执行 `validate_requirement`；该调用成功返回的需求 ID 仅授权紧邻的一次 `manual_source_creators`。
3. 拓展达人入参 `requirement_id` 必须与当次解析实际返回的新 ID 完全一致；旧 ID、错配 ID、已消费 ID 或没有成功解析证据时拒绝调用。
4. 一次性新 ID 绑定只使用当前会话的实际 Tool 结果，不查询历史需求库，也不把本地状态当成 Provider 成功证据。
5. 拓展达人导出链调整为 `select_inquiry_form_fields → validate_requirement → manual_source_creators → rank_creators → create_submission_batch`；拓展达人但不导出时不要求字段选择。

## Task Boundary

```yaml
goal: "让拓展达人可从任意阶段发起，同时强制每次调用使用紧邻需求解析新生成的一次性需求 ID"
allowed_paths:
  - "changes/CHG-2026-018-fresh-manual-requirement*.md"
  - "spec/**"
  - "YPmcn/src/**"
  - "YPmcn/tests/**"
  - "YPmcn/skills/media-assistant/**"
  - "YPmcn/state/confirmation_guard.json"
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
  - "packages/.staging/**"
  - "packages/releases/**"
acceptance:
  - "任意既有 phase 都能通过重新需求解析后发起拓展达人"
  - "每次 manual_source_creators 只接受紧邻成功 validate_requirement 返回的新 requirement_id"
  - "旧 ID、错配 ID、已消费 ID 和被其他业务 Tool 间隔的 ID 均不能调用拓展达人"
  - "拓展达人前不检查历史检索记录或其他流程完成度"
  - "本地契约、Skill、运行时提示、Hook 与测试一致"
verification:
  - "npm run test:fast"
  - "npm run verify"
  - "skill-creator/scripts/quick_validate.py YPmcn/skills/media-assistant"
  - "git diff --check"
  - "npm run pack:yp"
rollback: "回退本变更文件；不得删除或伪造远程业务事实"
```

## External Boundary

本地 Hook 只核对当前会话中紧邻成功解析结果与拓展达人入参的 ID 绑定，并在调用前一次性消费；它不证明 Provider 已持久化拓展达人结果，也不替代 Provider 的输入、事务、输出或全局唯一性校验。

## Verification Result

- `npm run test:fast`：通过，66 项插件测试通过。
- `python3 skill-creator/scripts/quick_validate.py YPmcn/skills/media-assistant`：通过，Skill 结构有效。
- `npm run verify`：通过，Spec、自动文档、安装图、安全扫描、插件、Provider 比较器、Skill 和发布内容门禁全部通过。
- `git diff --check`：通过。
- `npm run pack:yp`：通过，生成 `packages/releases/ypmcn-media-assistant-3.4.6.tgz`（110590 bytes，SHA-256 `07cf8fb117817246e39171ba622c9367fdb80393098d4002d316a88704a581a2`），包内版本和新规则已核对。
- 未执行生产写入验证；`tools/list` 无法证明 `validate_requirement` 每次生成全局唯一新 ID，因此 Provider 语义保持未验证。
