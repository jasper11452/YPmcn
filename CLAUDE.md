# YPmcn Claude Code 编排准则

## 适用范围与优先级

- 本文件与 `.claude/settings.json` 只约束从本仓库启动的 Claude Code，不得推广到其他项目。
- `AGENTS.md` 约束 Codex 的单任务执行行为；本文件约束 Claude Code 的任务分级、角色调度、独立验证、最终验收和提交。
- 正式契约以 `spec/manifest.json` 的 `contracts` 映射为唯一入口。
- 规则优先级：安全与数据完整性 > 正式 Spec > 角色硬限制 > 任务 acceptance 与 verification > 测试 > 当前实现 > Agent 推断。
- 任何角色规则都不得放宽安全、数据完整性、正式 Spec 或不可逆副作用限制。

## 默认流程

```text
确认 goal / allowed_paths / forbidden_paths / acceptance / verification
→ 按风险选择 Fast / Standard / Critical
→ 唯一写者完成最小修改和自测
→ 需要时由独立角色验证
→ Claude Code 最终验收并提交
```

任务边界使用：

```yaml
goal: "单一可观察结果"
allowed_paths: ["允许修改的路径"]
forbidden_paths: ["禁止修改的路径"]
acceptance: ["二元、可验证的完成条件"]
verification: ["必须运行的最小相关验证"]
```

## 任务分级

- `fast`：文档、机械修改、明确小修。Claude Code 直接实现、验证和提交，不强制独立 Verifier。
- `standard`：局部功能、Bug、内部重构。默认把边界明确的实现任务交给 Codex；若任务过小且委派成本高于实现成本，Claude Code 可直接执行。Codex 执行时，由 Claude Code 独立验收。
- `critical`：认证、权限、迁移、删除、发布、生产配置或不可逆副作用。Codex 在隔离 worktree 中执行，OpenCode 独立只读验证，Claude Code 最终验收；外部副作用必须获得人工批准。

## 三工具职责

### Claude Code

- 唯一 Orchestrator，负责定义边界、选择执行角色、控制范围、调用独立验证、最终验收和提交。
- 不把编排职责或 Verifier 选择权下放给 Codex。
- 只读审查任务不得修改或提交；开发任务验证通过后，只提交本任务可安全归属的改动。

### Codex

- Standard 和 Critical 的默认 Executor，只接收小而明确的单任务。
- 优先使用隔离 worktree，自测后交付 changed files、test results 和 known risks。
- 不负责调用 OpenCode、独立验证、最终验收或提交；具体规则见 `AGENTS.md`。

### OpenCode

- 默认仅作独立、只读 Verifier，输出 `PASS / FAIL + evidence`，不得修复代码。
- 只有 Codex 不可用、Codex 达到返工上限或用户明确指定时，Claude Code 才可将 OpenCode 切换为当前任务的唯一 Executor。
- OpenCode 成为 Executor 后不得同时验证该任务；必须由 Claude Code 或其他独立角色验收。

## 并发、预算与重试

- 单个任务只允许一个写者；写 Agent 最多 1 个，Verifier 最多 1 个。
- 只有用户请求被拆成 write set 完全不重叠的独立子任务且墙钟收益明确时，Claude Code 才可使用多个 worktree；每个子任务仍只有一个写者。
- 不为普通开发、方案调研或代码审查使用 Workflow、任务状态机、JSONL 或跨 Session 控制器。
- 上下文扩展最多 2 次；实现返工最多 2 次；自动重试最多 1 次。
- Fast 全链路上限 15k Token，Standard 50k，Critical 150k；达到预算 80% 后不得新增 Agent、扩大搜索或生成长报告。
- 同类工具故障第二次出现时停止重试，改走最短可行路径或报告唯一阻塞项。

## OpenCode 独立验证

由 Claude Code 直接调用原生 CLI，不经 Codex 或第三方 wrapper：

```sh
OPENCODE_DISABLE_EXTERNAL_SKILLS=1 opencode run --pure \
  --dir <repo> \
  --agent <verifier-agent> \
  --model "${OPENCODE_VERIFIER_MODEL:-yuepu/deepseek-v4-flash}" \
  --variant max \
  '<只读验证 prompt>'
```

执行要求：

- 使用专用只读 verifier；若不存在，使用当前 OpenCode 版本明确支持的通用 agent，并通过 prompt 和写入检查强制只读。
- 验证任务禁止使用 `--agent plan`，不要把 `--agent plan` 与 `--format json` 组合。
- 模型覆盖必须保持在 `yuepu/*`，除非用户明确指定其他 provider/model；禁止 `--auto`。
- Bash 调用设置 300000 ms 硬超时；超时、空输出或缺失明确 PASS/FAIL 均判 `FAIL`。
- 调用前后对比 `git status --short` 与相关 plan 目录；出现非预期写入直接判 `FAIL`。
- 不创建 `.runtime/*.jsonl` 或持久化验证文件；验证结果由 Claude Code 从标准输出汇总，除非任务明确要求产物文件。

可使用模板：

- `~/.claude/templates/task.yaml`
- `~/.claude/templates/verification.json`
- `~/.claude/templates/codex-executor-prompt.md`
- `~/.claude/templates/opencode-verifier-prompt.md`

项目规则与全局模板冲突时，以本文件和 `AGENTS.md` 为准；不得采用模板中的 `.runtime/*.jsonl`、固定包管理器或不同默认模型。

## 验证矩阵

默认运行任务相关测试、`git diff --check` 和修改范围检查。

| 命令 | 触发条件 | 要求 |
|---|---|---|
| 任务相关测试 | 所有代码修改 | 必跑 |
| `npm run test:fast` | 涉及 YPmcn 或 vector-mcp 运行逻辑 | 必跑 |
| `npm run test:openclaw` | 修改 Plugin、Skill、manifest 或 OpenClaw 适配 | 必跑 |
| `npm run test:headless` | Critical、跨组件联调或任务明确要求的合并前验证 | 必跑 |
| `npm run verify` | 风险、失败证据或发布门禁需要 | 最多运行一次 |
| `npm run pack:yp` + YP Action UI | 发布候选 | 必跑 |

补充规则：

- 人类文档同步使用 `npm run docs:sync`；提交前可运行 `npm run verify:docs`。
- 生产 provider 独立只读检查使用 `npm run verify:provider`。
- Headless 必须使用隔离配置，不得读取或修改 YP Action 正式用户配置，不得触发生产写操作。
- Headless 失败时保留首个协议或装载错误，不用 UI 重试掩盖。
- 测试未运行必须标记 `NOT RUN`；失败不得描述为通过。

## YPmcn 不可放宽的硬门禁

以下规则在 YPmcn 媒介工作流中任何情况下不得违反，Hook 会强制阻断违规调用：

1. **跳步阻断**：不得跳过正式 Spec 定义的 14 阶段工作流；阶段顺序由 `PreToolUse` Hook 强制执行。
2. **发送前三项确认**：`create_with_distributions` 前必须完成 supply、MCN、message 三项确认，并通过 `confirm_distribution_send` session action 写入；缺少任一项时返回 `CONFIRMATION_REQUIRED`。
3. **终态锁**：`recovered` 或 `closed` 后禁止重复写入；Hook 返回 `RECOVERY_ALREADY_TERMINAL`。
4. **不模拟成功**：只有实际 MCP 返回可作为证据，不得用预期返回或示例 JSON 冒充运行结果。
5. **ID 不发明**：下游 ID 无法从实际返回证明时，停止并返回 `integration_required`。
6. **Bash 不绕过**：禁止通过 shell、curl 或 PowerShell 直接调用 provider 写 API；Hook 返回 `INTEGRATION_REQUIRED`。

## 最终验收与提交

- Claude Code 必须检查 acceptance、验证结果、修改范围和最终 diff。
- 开发任务验证通过后，提交本任务可安全归属的改动并报告 commit hash。
- 仓库存在其他未提交改动时，只暂存和提交本任务文件；如果同一文件混有无法安全区分的既有改动，停止提交并报告唯一原因。
- 只读审查、用户明确禁止提交或验证失败时不得提交。

最终只报告：

```text
结果：完成 / 阻塞
改动：文件与一句话说明
验证：命令与 PASS / FAIL / NOT RUN
风险：无或具体风险
提交：commit hash 或唯一未提交原因
```

## 远程 MCP 开发机

- 局域网：`ssh 26969@192.168.0.129`
- Tailscale：`ssh 26969@100.82.209.65`
- Windows MCP server 项目：`D:\yp_local_mcp`
