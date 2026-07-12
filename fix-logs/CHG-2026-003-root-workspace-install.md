# CHG-2026-003：根目录安装未覆盖可构建组件

## Symptom

从无 `node_modules` 的工作树执行根 `npm ci` 后，`npm run verify` 在 `YPmcn` 构建阶段报 `tsc: command not found`。分别安装两个子组件依赖后，全量验证通过。

## Root Cause

仓库有根、插件和向量 MCP 三份 package manifest，但根包既未声明 npm workspaces，也未拥有两个组件的锁定依赖图。README 与 CI 把根目录描述为统一入口，CI 中额外的两次子目录安装掩盖了干净本地环境缺陷。

## Fix

- 根 `package.json` 精确声明 `YPmcn` 与 `vector-mcp` 两个 workspaces。
- 根 `package-lock.json` 由 npm 生成完整 workspace 依赖图。
- 新增静态回归测试，比较根 workspace 条目、根锁条目、组件 manifest 与组件锁文件。
- 将该测试纳入统一离线验证；验证阶段保持无隐式安装。

## Prevention

- 新增可构建 npm 组件时，必须同时更新根 workspaces、根锁文件和根安装图测试。
- 不用 CI 中的额外安装步骤替代根安装契约。
- 发布前从无依赖、无 `dist` 状态执行一次 `npm ci → npm run verify → npm run pack:yp`。

## Evidence

- 修复前：`node --test tests/root_workspace_install.test.mjs` 稳定失败，根 `workspaces` 为缺失。
- 修复后：同一测试通过；最终证据记录在 Change Proposal 的 Result 追加段和独立验证报告中。
