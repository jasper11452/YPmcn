# 正式 Spec

这里是仓库中唯一受版本控制的正式契约入口。先读 `manifest.json`，再按责任域读取对应文件；不要从 Skill、Hook、测试或历史实现反推契约。

## 权威顺序

```text
安全与数据完整性
> 已批准 Spec
> Change Proposal
> 测试与验证规则
> 当前代码实现
> Agent 推断
```

## 责任域

| 领域 | 权威文件 | 说明 |
|---|---|---|
| Database | `database.json` | 表、字段、writer ownership 与部署证明边界 |
| MCP | `mcp.json` | Tool、输入、输出、错误和副作用契约 |
| Hook | `hooks.json` | Hook 事件、确定性守卫和禁止越界范围 |
| Skill | `skills.json` | 可用 Tool、调用前置条件和错误/工作流引用 |
| Workflow | `workflow.json` | 阶段、转换、恢复和响应状态 |
| Errors | `errors.json` | 全局错误语义与重试边界 |
| Requirements | `requirements.json` | canonical 输入、字典引用、金额/deadline、约束、Join Gate、迟到数据与 offer promotion |
| Algorithms | `algorithms.json` | 算法契约就绪状态；未批准时保持阻断 |

`requirement-dictionary.json` 是 `requirements.json` 引用的无客户内容字段字典；`spec/schemas/` 提供生成与实例校验用 JSON Schema，并随 Spec 构建快照发布。它们不构成 Migration 或部署证明。

`profiles/legacy-1.9.4.json` 仅用于只读兼容性检测，不是可执行或可回退的生产契约。

## 修改规则

1. 先在 `changes/` 创建并批准 Change Proposal 和 Impact Analysis。
2. 先改 Spec，再按依赖顺序改实现和测试。
3. 一个概念只在一个领域 Spec 定义；其他文件使用路径引用，不复制参数 Schema。
4. 插件发布包中的 `spec/` 是从本目录生成的构建副本，不是第二个开发源。
5. JSON 是本项目当前的机器契约格式。不要为了匹配示例扩展名再维护一份 YAML 镜像。
