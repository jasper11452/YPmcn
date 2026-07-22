# TAPD → Codex 自动交付缺少 GitHub 闭环

## Symptom

- Codex 修复、离线测试、版本升级和打包完成后，结果只停留在本机。
- 没有可信的 push、PR、CI 后置审批、自动合并和合并状态回收。
- 人工业务 checkout 的并发改动会使隔离运行按安全规则中止。

## Root Cause

- 本地状态机终止于 `PACKAGED`，没有 GitHub 交付状态。
- 自动化复用了人工开发目录，没有专用同步克隆。
- GitHub `main` 没有必需检查和审批保护，也没有可信的后置合并工作流。

## Fix

- 使用专用克隆和 detached worktree，保留人工目录中的修改。
- 增加幂等 push、完整 PR、`PR_OPEN → MERGED` 状态和按 TAPD ID 的完成凭据。
- CI 继续在只读权限的 GitHub 托管 runner 上执行。
- 新增不 checkout PR 的 `workflow_run` 门禁，复核作者、分支、SHA、标签、标记和路径后，
  由 GitHub Actions 审批并启用 squash auto-merge。
- 保护 `main`：要求最新分支、`offline-verification`、一个批准、解决对话和线性历史；
  管理员也不能绕过，禁止 force-push 和删除。

## Verification

- 本机 `ruff`、`mypy` 和 Python 单测通过。
- 专用克隆 `npm run verify` 通过。
- 引导 PR #3 的 GitHub `offline-verification` 通过。
- 本冒烟 PR 用于验证 CI、Actions 审批、auto-merge 和分支删除的真实闭环。

## Prevention

- 公开仓库只使用 GitHub 托管 runner，不把 PR 代码放到本机 self-hosted runner 执行。
- 有写权限的工作流永远不 checkout 或执行 PR 内容。
- 不删除本机 `var/state.sqlite3`，避免已合并的 TAPD ID 被再次领取。
- 自动 PR 不得修改 `.github/**`；工作流变更必须单独人工引导。
