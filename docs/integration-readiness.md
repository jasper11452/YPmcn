# YPmcn v3 集成与上线就绪报告

日期：2026-07-12

目标契约：`mvp-v2`

发布版本：`3.0.0`

## 当前开发数据库契约（2026-07-16）

- 平台落库与业务 Tool 使用 `xiaohongshu`、`douyin`；`xhs`、`dy` 仅作为输入别名。
- MySQL 达人身份物理列使用 `kwUid`；MCP 参数与 Python 属性可使用 `kw_uid`，但 ORM 必须显式映射。
- 需求主键是 `customer_demands.id`，业务版本键是 `demandId + demandVersion`；`search_creators.id` 与 `rank_creators.requirement_id` 均传需求主键。
- `creator_candidate_pool` 通过 `id + platform + kwUid` 绑定当前需求并保留历史记录。
- 跨表关联键使用 `utf8mb4_unicode_ci`；需求主键为 `char(32)`，达人 ID 为 `varchar(64)`。
- 行业和品牌语义由向量检索处理，不把 `businessIndustry` 或 `tagBrand` 空值作为 SQL 硬性不匹配。
- 无报价候选可排序，但必须标记 `NO_ACTIVE_OFFER` / `need_confirm`；排序不设置最低候选数量。
- 回收按 `inquiry_id + platform + kwUid` 幂等更新。

## 1. 结论

| 评估面 | 结果 | 结论 |
| --- | --- | --- |
| 正式契约收口 | **PASS** | P0 与首批 P1 已有唯一 Spec 落点、JSON Schema、loader 与契约测试。 |
| 下游实现就绪 | **BLOCKED** | CHG-2026-007 是 contract-only；数据库、provider 与 Hook/Skill 尚未按新契约迁移。 |
| 独立只读审查 | **待本变更冻结后执行** | OpenCode 必须复验冻结 SHA，并确认 Git 与 plan 目录无写入。 |
| 生产 provider 契约 | **FAIL / BLOCKED** | 线上仍是 `legacy-1.9.4`，缺 3 个 v2 工具且已有工具 schema 与 v2 存在 286 项差异。 |
| 生产数据库与后端不变量 | **EXTERNAL-UNVERIFIED** | Spec 已声明 14 项必须证明的不变量，但仓库测试不能代替迁移、约束、并发和部署证据。 |
| 生产总体就绪 | **NO-GO** | 现有包只能代表旧 SHA 的离线证据；CHG-2026-007 下游实现、provider、数据库、Algorithm 与凭据门禁通过前不得开启生产新链路。 |

这里的生产阻塞不是通过更多本地测试就能消除。CHG-2026-007 定义的是目标业务契约；当前差距来自生产 provider、数据库和 Hook/Skill 尚未完成对应升级。Host 只以 `mcp__ypmcn__<contract-tool>` 识别业务工具，`tools/list` 仍使用 bare tool name，`vector-mcp` 不得伪装成业务 provider。仓库刻意不把旧 provider 或本地 Hook session projection 伪装成服务端权威，也不自动降级。

## 2. 仓库验收证据

CHG-2026-007 的目标验收命令是 `npm run verify`。通过后它只证明仓库契约、现有回归与离线组件自洽，不证明下游部署完成。当前统一验证覆盖 204 项测试；上一冻结基线的证据原文为“统一验证覆盖 191 项测试”。当前清单已移除 13 项废弃的跨 Session Agent 控制面测试，并纳入此后新增的契约与回归测试。

- Spec 治理与漂移门禁：11 项，覆盖 manifest、Schema 引用、字典 hash、逐工具输出和 finding 唯一落点。
- 人类文档同步、自动提交与精简度：5 项。
- 根 workspace 安装图：1 项。
- 密钥与发布边界：16 项。
- OpenClaw 插件、契约与 Hook：122 项，覆盖实体、输出契约、工作流状态和错误语义。
- provider checker：8 项；Python Hook：24 项。
- Skill、工具卡和文档一致性：16 项。
- 向量 MCP 可靠性：14 项。
- 可复现发布包：8 项。

验证结果同时证明：

- `create_with_distributions` 缺少会话、调用证据、发送角色、三项确认、字段快照或正确阶段时均 fail closed。
- 禁止 `preview_only` 和 shell/curl 绕过 provider 写接口。
- 现有 Hook 回归仍证明当前会话确认与 `ctx.trigger=cron` 只能作为本地 deny-only 防线；它们不能授予目标服务端动作。
- 目标恢复契约固定为 `refresh → request → finalize`；现有工具映射为 `sync → ingest → sync`，终态 refresh 为无副作用 no-op，服务端迁移留给后续 Change。
- Python Hook 测试只验证本地守卫与状态机，不作为生产 provider 证据。
- tracked 文件和发布包的密钥扫描均为零发现；发布包不包含 mock、测试、源码、凭据或绝对路径。
- 既有 `3.0.0` tgz 只代表其生成 SHA 的历史证据；本 contract-only 任务不生成或发布新包。

独立验证必须在实现提交冻结后由不同模型只读检查完整差异，复跑密钥扫描及关键测试，并把结果写入本任务 verification 工件。未完成前不得把本节解释为 Reviewer 已批准。

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

`spec/database.json` 是目标验收要求，不是 migration 或 deployment proof。以下 14 项当前均为 `external-unverified`：

| 不变量 | 责任边界 | 放行证据 |
| --- | --- | --- |
| supplier binding 唯一 | 生产数据库 | 每个 `(mcn_id, provider, scope, as_of)` 恰好一个 active binding；provider supplier ID 物理唯一。 |
| 单一 send operation | 分发 provider 后端 | idempotency key 与 provider correlation key 唯一；每次发送引用一个 persisted selection result。 |
| 稳定 provider correlation | 分发 provider 后端 | 未知写结果先按 correlation 查询，同 operation 对账，不直接重发。 |
| 首次 refresh 原子性 | 同步后端 | snapshot、batch、每 supplier inquiry、cron 在同一事务中创建或复用。 |
| provider 引用唯一 | 数据库与 provider | distribution ID、token、fill link 非空唯一。 |
| 提交摄取幂等 | ingest 后端 | `(provider_distribution_id, provider_row_id)` 唯一。 |
| 单一 recovery owner | 恢复协调器 | request 通过 state version CAS/行锁只产生一个 owner。 |
| 多来源合并优先级 | 排名后端 | 继续证明 approved source priority；算法权重仍由外部 Algorithm Spec 决定。 |
| submission batch 重试 | submission 后端 | 同 run 复用未完成批次，仅 approved next action 创建新批次。 |
| 字典与快照绑定 | requirement/selection 服务 | requirement、snapshot、selection 精确保存 approved dictionary version/hash。 |
| 单平台执行单元 | requirement 服务 | 多平台输入生成同一 head 下的逐平台 child；物理唯一键拒绝重复版本。 |
| snapshot/审计不可变 | 数据库与各 owner | snapshot、risk/feedback/promotion audit append-only，纠正只追加新版本。 |
| late data 不改冻结结果 | supply/ranking 服务 | 迟到记录保留 lineage 并进入下一 snapshot/人工复核；旧 hash 不变。 |
| offer promotion 版本化幂等 | supply 服务 | promotion 新增 offer revision 与 audit event；相同 source/scope 只晋升一次。 |

此外，目标模型中的每个实体都必须有真实 primary/unique constraint、非空 scope 字段和对应并发/冲突测试。仓库 JSON Schema、loader 与本地测试只能证明契约可生成、可检查，不能替代这些外部证据。

## 5. 凭据处置

当前源码和发布包已无可识别硬编码凭据，但历史版本曾出现真实格式凭据。因此上线前仍必须完成一次独立的凭据轮换与撤销：

- 轮换数据库、provider/API、企微和向量服务相关凭据。
- 撤销历史凭据并检查最近使用记录，而不是只修改当前环境变量。
- 通过受控 secret store 注入新值；日志和验收材料只记录 key 名、轮换时间与责任人，不记录值。
- 轮换后重新运行 tracked 与 tarball 密钥扫描。

“当前扫描为零发现”只能证明新包干净，不能证明历史凭据仍然安全。

## 6. 精确上线门禁

只有以下条件全部满足，生产结果才能从 `NO-GO` 改为 `GO`：

1. **实现门禁**：后续 Change 按 Database → MCP → Hook/Skill → Integration 顺序实现 CHG-2026-007；contract-only 提交本身不放行生产。
2. **凭据门禁**：历史凭据已轮换、旧值已撤销，secret store 与审计记录可追溯。
3. **provider 契约门禁**：生产 `tools/list` 包含 14 个必需工具，输入 schema 与 `mvp-v2` 一致，逐工具成功/失败输出通过 output contract 集成测试；`npm run verify:provider` 返回 0。
4. **需求门禁**：字典不含客户内容，requirement/snapshot/selection 的 version/hash 可复算；canonical raw 冲突、金额/deadline/constraint 错误均 fail closed。
5. **状态门禁**：服务端持久化 `state_version + allowed_actions`，未列状态组合阻断；恢复严格执行 `refresh → request → finalize`，Hook session 不能授予动作。
6. **发送安全门禁**：selection result 和 send operation 均持久化；provider 给出稳定 correlation key；未知结果只查询不重发。
7. **数据库门禁**：上节 14 项不变量均有 migration/constraint/transaction 证据及对应集成或并发测试记录。
8. **Algorithm 门禁**：`spec/algorithms.json` 从 `external-unverified` 进入单独批准并有独立验证；不得从当前代码或本 Requirements Spec 反推排名权重。
9. **完整链路门禁**：隔离租户完成 `validate/split → snapshot → search → rank MCN → persist selection → send operation → refresh → request → finalize → rank → submit → feedback`，并验证 recovery owner、late data 和 offer promotion 冲突。
10. **发布与灰度门禁**：最终提交重新运行 `npm run verify`、`npm run pack:yp` 和 tarball 密钥扫描；先受控灰度，观察重复发送、scope/join、状态冲突、迟到数据和晋升幂等指标。

任一门禁失败时，新链路保持关闭。不得通过放宽 schema、重新启用 mock 成功、跳过确认或回退到含凭据的旧包来换取“绿色”状态。

## 7. 回滚边界

- Hook 或插件行为异常时，回滚到上一安全发布包，同时关闭 v3 新链路。
- provider/数据库迁移按独立 Change Proposal 回滚；不得由插件自行改表或猜测兼容字段。
- 发生发送结果未知时，保留 send operation 与 correlation key 并走服务端 refresh 对账，不直接执行第二次发送。
- 本地 Hook 与测试工具任何时候都不能接管生产流量。
