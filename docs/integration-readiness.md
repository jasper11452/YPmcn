# YPmcn v3 集成与上线就绪报告

日期：2026-07-11

目标契约：`mvp-v2`

发布版本：`3.0.0`

## 1. 结论

| 评估面 | 结果 | 结论 |
| --- | --- | --- |
| 仓库实现验收 | **PASS** | 契约、Hook、reference MCP、向量 MCP、文档、密钥扫描和打包测试全部通过。 |
| 独立只读审查 | **PASS** | 未发现发送 fail-open、恢复绕过、密钥泄露、陈旧构建物或自动降级旧契约。 |
| 生产 provider 契约 | **FAIL / BLOCKED** | 线上仍是 `legacy-1.9.4`，缺 3 个 v2 工具且已有工具 schema 与 v2 存在 286 项差异。 |
| 生产数据库与后端不变量 | **EXTERNAL-UNVERIFIED** | Spec 已声明 9 项必须证明的不变量，但仓库测试不能代替迁移、约束、并发和部署证据。 |
| 生产总体就绪 | **NO-GO** | v3 包可以用于离线验收和集成环境；在 provider、数据库与凭据门禁全部通过前不得开启生产新链路。 |

这里的生产阻塞不是四份原始文档错误，也不是本地构建失败。文档定义的是目标业务契约；当前差距来自生产 provider 和数据库后端尚未完成对应升级。仓库刻意不把旧 provider 伪装成 v2，也不自动降级。

## 2. 仓库验收证据

`npm run verify` 已通过，统一验证覆盖 172 项测试：

- Spec 治理与漂移门禁：6 项。
- 密钥与发布边界：16 项。
- OpenClaw 插件、契约与 Hook：104 项。
- reference MCP 与 provider checker：8 项。
- Skill、工具卡和文档一致性：16 项。
- 向量 MCP 可靠性：14 项。
- 可复现发布包：8 项。

验证结果同时证明：

- `create_with_distributions` 缺少会话、调用证据、发送角色、三项确认、字段快照或正确阶段时均 fail closed。
- 禁止 `preview_only` 和 shell/curl 绕过 provider 写接口。
- 手工回收只接受当前会话的明确确认；定时回收只接受 `ctx.trigger=cron`。
- 回收固定为 `sync → ingest → sync`，已终态请求为无副作用 no-op。
- reference MCP 不联网、不写生产库、不发送企微，并在结果中标记 `simulated: true` 与 `productionEvidence: false`。
- tracked 文件和发布包的密钥扫描均为零发现；发布包不包含 mock、测试、源码、凭据或绝对路径。
- `packages/releases/ypmcn-media-assistant-3.0.0.tgz` 已完成构建、内容约束和二次密钥扫描。

独立验证使用不同模型、只读检查完整提交差异，并复跑密钥扫描及关键测试；结果为 `PASS`、零 findings。该审查没有修改工作树。

## 3. 当前生产 provider 差距

只读门禁命令：

```bash
npm run verify:provider
```

本次结果为预期的非零退出：

| 字段 | 当前值 |
| --- | --- |
| 状态 | `FAIL` |
| 识别 profile | `legacy-1.9.4` |
| 缺失工具 | `select_inquiry_form_fields`、`create_with_distributions`、`sync_mcn_inquiry_status` |
| schema 差异 | 286 项 |
| 当前 tools/list schema hash | `80d67b3c3b4ca7fe447836770272991dd6a48b7c8b99ec2b4e230e3a3feb2b99` |

检查器只发送 `initialize`、`notifications/initialized` 和 `tools/list`，不会调用任何业务工具或产生写入。缺失 3 个工具只是最直观的阻塞；286 项 schema 差异说明现有同名工具参数也不能视为 v2 兼容。

## 4. 尚需外部证明的数据库与后端不变量

`spec/database.json` 是验收要求，不是 migration 或 deployment proof。以下 9 项当前均为 `external-unverified`：

| 不变量 | 责任边界 | 放行证据 |
| --- | --- | --- |
| supplier 映射唯一 | 生产数据库 | `mcn_agencies.supplier_id` 非空唯一；目标 MCN readiness query 均恰好返回一个 supplier。 |
| 单一发送上下文 | 分发 provider 后端 | `(mcn_recommendation_id, requirement_id)` 只有一个发送上下文；重发必须生成新的 recommendation ID。 |
| 稳定 provider 关联键 | 分发 provider 后端 | 记录稳定 correlation key；超时后先查询状态，不重复发送。 |
| 首次同步原子性 | 同步后端 | snapshot、batch、每 supplier inquiry、cron 在同一事务中创建或复用；并发测试返回同一组对象。 |
| provider 引用唯一 | 数据库与 provider | `provider_distribution_id`、token、fill link 非空唯一；重复或空引用被集成测试拒绝。 |
| 提交摄取幂等 | ingest 后端 | `(provider_distribution_id, provider_row_id)` 唯一；重复行只形成一个逻辑 submission item。 |
| 单一回收 owner | 数据库与恢复协调器 | CAS 或行锁保证手工与定时并发时只有一个 ingest owner。 |
| 多来源合并优先级 | 排名后端 | `mcn_submission > manual_source > candidate_pool`；自动排名只接收 `accepted`。 |
| 提交批次重试语义 | submission 后端 | 同 run 重试复用未完成批次；仅 `continue_submission` 后允许创建新批次。 |

这些不变量必须由生产迁移记录、唯一约束/事务实现和并发集成测试共同证明。reference MCP 的成功结果不能作为替代证据。

## 5. 凭据处置

当前源码和发布包已无可识别硬编码凭据，但历史版本曾出现真实格式凭据。因此上线前仍必须完成一次独立的凭据轮换与撤销：

- 轮换数据库、provider/API、企微和向量服务相关凭据。
- 撤销历史凭据并检查最近使用记录，而不是只修改当前环境变量。
- 通过受控 secret store 注入新值；日志和验收材料只记录 key 名、轮换时间与责任人，不记录值。
- 轮换后重新运行 tracked 与 tarball 密钥扫描。

“当前扫描为零发现”只能证明新包干净，不能证明历史凭据仍然安全。

## 6. 精确上线门禁

只有以下条件全部满足，生产结果才能从 `NO-GO` 改为 `GO`：

1. **凭据门禁**：历史凭据已轮换、旧值已撤销，secret store 与审计记录可追溯。
2. **provider 契约门禁**：生产 `tools/list` 包含 14 个必需工具，所有输入 schema 与 `mvp-v2` 一致，`npm run verify:provider` 返回 0、`missingTools=[]`、`schemaDiffs=[]`。
3. **发送安全门禁**：provider 给出稳定 correlation key；未知结果只查询不重发；三项确认、字段快照与幂等发送在集成环境有证据。
4. **数据库门禁**：上节 9 项不变量均有 migration/constraint/transaction 证据及对应集成或并发测试记录。
5. **完整链路门禁**：在隔离测试租户完成一次 `validate → search → rank MCN → select fields → send → first sync → wait → sync → ingest → sync → rank → submit → feedback`，并验证手工/定时回收竞争只有一个 owner。
6. **发布门禁**：在最终提交上重新运行 `npm run verify` 和 `npm run pack:yp`；tarball 扫描为 `[]`，四处版本元数据一致。
7. **灰度门禁**：先对受控目标启用 v3，观察重复发送、provider 引用缺失、cron 重复、状态冲突与摄取幂等指标；无异常后再扩大范围。

任一门禁失败时，新链路保持关闭。不得通过放宽 schema、重新启用 mock 成功、跳过确认或回退到含凭据的旧包来换取“绿色”状态。

## 7. 回滚边界

- Hook 或插件行为异常时，回滚到上一安全发布包，同时关闭 v3 新链路。
- provider/数据库迁移按独立 Change Proposal 回滚；不得由插件自行改表或猜测兼容字段。
- 发生发送结果未知时，保留 correlation key 并走查询/sync 恢复，不执行第二次发送。
- reference MCP 只用于离线回归，任何时候都不能接管生产流量。
