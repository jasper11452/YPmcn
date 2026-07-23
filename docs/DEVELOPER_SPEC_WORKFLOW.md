# 开发者使用手册：怎样安全地改这个项目

这份手册面向人工开发者。第一次接手时，建议按[文档导航](README.md) → [项目地图](PROJECT_MAP.md) → [集成与上线就绪](integration-readiness.md)的顺序读；需要判断字段或流程时，再回到根目录 `spec/`。

## 1. 先认识当前边界

项目根目录是唯一长期入口。`YPmcn/` 是同一仓库内可发布的 OpenClaw/YP 插件组件，不是另一份项目；临时 worktree 只是隔离任务的工作空间，不能成为新的事实源或发布入口。

当前系统分三层：

```text
已批准 Spec：定义应该怎样工作
        ↓
YPmcn 插件：提示、确定性校验、本地编排投影
        ↓
远端 MCP / MySQL：真实业务读写与外发结果
```

最重要的实践含义是：本地测试通过不代表远端可用；本地状态文件写入不代表业务写入成功。当前远端 Provider 与批准契约仍有两处硬差异，因此项目状态是 **NO-GO**，详见[集成与上线就绪](integration-readiness.md)和[运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)。

## 2. 目录应该怎样用

| 目录 | 用途 | 修改时的规则 |
| --- | --- | --- |
| `spec/` | 已批准的机器契约 | Tool/字段/阶段/错误/不变量改变时，先走 Change Proposal |
| `changes/` | 需求、提案、影响分析与决策证据 | 新增或补充证据；不要改写已发布历史来伪造今天状态 |
| `YPmcn/` | Skill、Hook、工具参考与插件构建 | 按已批准契约做最小实现，不把业务事实塞进本地状态 |
| `tests/` | 契约、集成、发布测试 | 与行为同步；禁止通过删断言把测试变绿 |
| `scripts/` | 验证、文档同步、打包 | 尽量确定性和只读；生产副作用需明确授权 |
| `docs/` | 当前说明、审计快照、历史方案 | 写清证据时间与范围，避免把计划写成现状 |
| `packages/` | 生成的安装包 | 不手工编辑 |
| `fix-logs/` | 可复用的故障闭环 | 记录根因、影响、验证和预防，而不是临时聊天摘录 |

`doc/` 若仍被个别 Spec 作为来源别名引用，只是来源材料，不是机器事实源。来源与 Spec 冲突时，先更新 Spec，不让代码自行裁决。

## 3. 哪些改动要先走提案

以下任何一项变化，都先写/批准 Change Proposal 和 Impact Analysis，再动实现：

- Tool 参数、返回、错误码、权限、写入/外发副作用；
- 数据库字段、唯一性、幂等、迁移或主键语义；
- 工作流阶段、恢复条件、是否能跳步；
- Hook 的阻断条件或它保存的状态；
- 算法输入输出或向量治理规则。

纯文档错字、代码内部重构、日志或补测通常不用改对外 Spec，但仍要说明范围、运行相关验证。举例说，把文档中的 `manual_source_creators(requirement_id, target_count)` 更新为 `manual_source_creators(requirement_id, size)` 是文档修正；把 `size` 改成数字类型则是 MCP 契约变化。

## 4. 推荐的日常流程

```text
需求
→ Change Proposal（需要时）
→ Impact Analysis
→ Spec 批准
→ 按依赖拆成小任务
→ 隔离工作区实施
→ 最小直接验证
→ Review
→ 打包与发布门禁
```

开始修改前先检查 `git status`。已有改动可能属于别的任务；除非明确授权，不覆盖、不重置、不顺手格式化无关文件。并行任务要分到不重叠的文件；数据库 → MCP → Hook/Skill → 集成测试这条真实依赖链仍按顺序推进。

## 5. 理解当前 Hook 和外发行为

插件目前只有四个 Hook：

| Hook | 当前职责 | 不应误解为 |
| --- | --- | --- |
| `before_prompt_build` | 准备 Brief、提示和本地编排状态 | 完整业务状态机或数据库写入 |
| `before_tool_call` | 对特定 Brief/ID 做确定性守卫，阻止 shell 绕过 | 通用 Provider 授权器 |
| `after_tool_call` | 根据真实结果更新本地投影 | 替 Provider 认定写入/外发成功 |
| `session_end` | 清理过期本地状态 | 自动恢复或补偿业务事务 |

`create_with_distributions` 当前每次都会先被插件拦下，并展示本地 `AskUserQuestion` 确认。用户明确确认后，最新未过期回执可跨对话轮次放行**下一次**调用一次；取消、拒绝、关闭或超时都不调用 Provider。当前实现消费该回执时不再比较下一次调用的参数，因此不能把它误当作长期或通用授权，新的外发尝试仍应重新确认。这个确认只证明“允许发起”，不证明“已经送达”：开发或联调仍应使用隔离测试机构/群，并只把 Provider 返回的逐机构 `sent` 明细作为发送成功证据。`sync_mcn_inquiry_status` 仅是同步证据，不能反推消息已经发出。

## 6. 验证命令怎么选

```bash
# 干净工作树首次安装
npm ci

# 离线总门禁：契约、插件、测试、打包等
npm run verify

# 文档自动事实区块是否与 Spec 一致
npm run verify:docs

# 插件快速回归
npm run test:fast

# 源码插件装载检查
npm run test:openclaw

# 生成并扫描安装包
npm run pack:yp

# 只读检查生产 Provider 的输入契约
npm run verify:provider:prod
```

这些命令不是同一种“通过”。例如 `npm run verify` 通过，只能说明仓库离线门禁通过；`npm run verify:provider:prod` 当前发现 schema 不兼容时会失败，这正是阻止上线的有效证据。不要通过放宽本地 Schema、伪造响应或跳过检查来换取绿色结果。

真实 E2E 还需要单独条件：隔离测试数据、不会误发给真实机构的通道、可回收方案、操作授权和原始响应的脱敏留存。缺任一项时，写 `BLOCKED`，不要把 Mock 成功写成生产成功。

## 7. 文档和提交前检查

完整暂存的 Spec 或正式 Change Proposal 会触发 pre-commit，同步 `docs/README.md`、`docs/PROJECT_MAP.md`、`docs/EVOLUTION.md` 中的机器事实区块。需要预览或修复时可执行：

```bash
npm run docs:sync
npm run verify:docs
```

脚本只能检查自动区块；叙事是否过时仍要人工核对。尤其要检查版本号、远端兼容状态、外发确认语义、工具参数名和“计划/已完成”的措辞。

## 8. 什么时候可以发布

发布不是“构建成功”。最低顺序是：Spec 已批准 → 实现完成 → 相邻测试通过 → Review 完成 → 安装包通过 → 远端兼容与隔离 E2E 有证据 → 发布批准。

当前阶段不应把包发布到生产：Provider 输入契约尚未对齐、稳定成功出参和生产级恢复/并发证明不足，算法定义也尚未外部验证。若要解除 NO-GO，应逐条补证据，而不是降低门槛。
