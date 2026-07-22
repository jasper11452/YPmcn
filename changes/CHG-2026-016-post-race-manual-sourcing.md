# CHG-2026-016：赛后决定精确拓展达人补量

```yaml
task_id: CHG-2026-016-POST-RACE-MANUAL-SOURCING
change_type: behavior-correction
status: IMPLEMENTED_LOCAL_PROVIDER_BLOCKED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户明确要求拓展达人数量决策放在 MCN 赛马之后，并批准 20/30 倍风险阈值及缺口公式"
baseline: "a086eabbf6bc41adff00bb58560f37423f47b2c2"
rollback_strategy: "回退 3.4.3 插件与本变更 Spec；不得删除已创建的远程询价或拓展达人任务"
```

## Problem

3.4.1 在 `search_creators` 后、`rank_mcns` 前展示并确认精确拓展达人数量。此时只能看到全资源库刊例覆盖，尚未确定实际询价机构，也无法得到这些机构覆盖达人的去重并集；提前给出精确数量会把资源库倍率误当成已选机构倍率。

## Decision

1. 赛马前只使用刊例资源人数与需求数计算刊例倍率，不生成、不保存、不调用精确 `target_count`。
2. 风险边界固定为：倍率 `<20` 为 `high_risk`，`20≤倍率<30` 为 `medium_risk`，`≥30` 为 `safe`；比较使用整数覆盖数与 `需求数×阈值`，不依赖四舍五入后的展示值。
3. 赛马前 `<20` 强烈建议先扩机构或预拓展达人到至少 20 倍；中风险允许继续赛马但建议补资源；安全档无需拓展达人。
4. `rank_mcns` 的继续证据必须绑定媒介实际选定的询价机构集合，并返回该集合按 `(platform, kwUid)` 去重后的覆盖并集、倍率和风险档。
5. 仅当赛后已选机构倍率 `<20` 时，精确建议量为 `需求数×20−已选机构覆盖去重并集数`；`≥20` 时精确建议量必须为空，不得提前或过度建议。
6. 高风险赛后弹窗提供“一键发起拓展达人补量”；提交后才把上述精确缺口保存为 `pending_manual_target_count` 并调用 `manual_source_creators`。
7. 后续实际询价机构必须与本次覆盖计算绑定的机构集合一致；机构集合变化必须重新计算倍率和建议量。
8. `rank_mcns.inquiry_id` 与达人拓展任务证据门禁保持不变；赛后补量确认不授权企微外发。

## Task Boundary

```yaml
goal: "把精确拓展达人决策移到实际询价机构覆盖去重并集计算之后，并落实 20/30 倍风险边界"
allowed_paths:
  - "changes/CHG-2026-016-post-race-manual-sourcing*.md"
  - "spec/**"
  - "YPmcn/src/**"
  - "YPmcn/dist/**"
  - "YPmcn/tests/**"
  - "YPmcn/skills/media-assistant/**"
  - "YPmcn/README.md"
  - "docs/MANUAL_SOURCING_WORKFLOW_OPTIMIZATION_PLAN.md"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "tests/**"
  - "package.json"
  - "package-lock.json"
  - "YPmcn/package.json"
  - "YPmcn/package-lock.json"
  - "YPmcn/openclaw.plugin.json"
  - "YPmcn/.claude-plugin/plugin.json"
  - "YPmcn/.codex-plugin/plugin.json"
forbidden_paths:
  - ".env*"
  - "packages/.staging/**"
  - "packages/releases/**"
acceptance:
  - "赛马前只展示刊例倍率与风险建议，状态中不存在精确拓展达人 target_count"
  - "赛后覆盖数 99/需求 5 为高风险且精确建议 1；覆盖数 100 为中风险且不生成精确建议"
  - "倍率 20 归中风险，倍率 30 归安全档"
  - "赛后高风险只有点击一键补量才调用 manual_source_creators，数量严格等于公式结果"
  - "询价机构集合变化会阻断旧覆盖结论用于外发"
  - "本地契约、Hook、Skill 与发布包验证通过"
verification:
  - "npm run test:fast"
  - "npm run verify"
  - "git diff --check"
rollback: "回退 3.4.3；远程已创建事实只按权威状态处置，不伪造回滚"
```

## External Boundary

本仓库没有生产 Provider 或数据库 migration 源码。`rank_mcns` 返回“实际已选机构集合 + 去重覆盖并集”是本变更新增的目标业务证据；远端未部署并通过 `(platform, kwUid)` 去重、机构集合绑定和隔离 Live E2E 前，赛后一键补量分支保持 `integration_required`。

## Verification Result

- `npm run verify`：通过。
- `npm run test:openclaw`：通过，OpenClaw 插件、Skill 与 MCP 配置可加载。
- `git diff --check`：通过。
- 生产 Provider 不在本仓库，尚未验证目标输出字段、去重实现与隔离 Live E2E，因此生产状态仍为阻塞。
