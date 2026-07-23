# YPmcn 3.1.0 集成与上线就绪报告

日期：2026-07-18

目标契约：`mvp-v2`

仓库版本：`3.1.0`

## 当前开发数据库契约（2026-07-18）

- 平台落库与业务 Tool 使用 `xiaohongshu`、`douyin`；`xhs`、`dy` 仅作为输入别名。
- MySQL 达人身份物理列、MCP 参数与代码字段统一使用 `kwUid`。
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
| 插件与本地门禁 | **PARTIAL** | Skill、打包和 Native Node Hook 已进入当前执行面；Hook 用本地 JSON 记录编排状态，并只对企微外发做 AskUserQuestion 参数绑定确认，不能替代服务端参数与写幂等。 |
| 独立只读审查 | **待本变更冻结后执行** | OpenCode 必须复验冻结 SHA，并确认 Git 与 plan 目录无写入。 |
| 开发 provider 契约 | **READ-ONLY PASS** | 开发与生产现统一使用公开 SSE endpoint；2026-07-19 实时 `tools/list` 确认 15 个目标业务 Tool 齐全且输入 schema 无差异。 |
| 生产 provider 契约 | **READ-ONLY PASS** | 同一统一 endpoint 的 2026-07-18 实时只读检查通过；这不等于写行为或 Live E2E 通过。 |
| 数据库与后端不变量 | **DIRECTLY VERIFIED / SOURCE IMPLEMENTED / REMOTE UNVERIFIED** | 2026-07-18 已从当前机器只读直连 MySQL 8.0.36 核对真实表、列、索引和行数；`customer_demands` 与 `field_match_mapping` 作为权威保持不改。独立后端工作树已接入 ledger、真实 distribution/notification sync 与工作流派生测试，但远程进程尚未部署验收。 |
| 生产总体就绪 | **NO-GO** | `3.1.0` 的本地证据不能代替当前 provider、数据库迁移、真实 Agent E2E、Algorithm 和凭据门禁。 |

这里的阻塞不是通过更多本地单测就能消除。仓库的开发与生产 Provider 均配置为 `https://mcp.eshypdata.com/sse`，不再存在开发机专线、SSH 隧道或本地端口转发路径。统一 endpoint 的只读 `tools/list` 只能证明当前广告契约，不证明写 Tool、远程后端部署或 Live E2E 已通过。Host 只以 `mcp__ypmcn__<contract-tool>` 识别业务工具；本地 `vector-mcp` 不进入插件包，向量能力应作为远程 `search_creators`/`rank_creators` 的内部组件。

## 2. 仓库验收证据

`npm run verify` 通过后只证明当前 checkout 的契约、回归、构建和离线发布结构自洽，不证明远程服务或真实业务链完成。测试数会随改动变化，因此不再把旧的 191/204 项数字当门禁；发布记录应保存命令、提交 SHA、时间和原始退出码。当前清单是：

| 检查 | 命令 | 能证明什么 |
| --- | --- | --- |
| OpenClaw 插件、契约与 Native Node Hook | `npm run test:fast` | 非外发 Tool 放行、本地 JSON 转换、企微外发 AskUserQuestion 两阶段确认、业务契约和本地 vector MCP 协议 smoke |
| OpenClaw 源码装载 | `npm run test:openclaw` | YP 内置 OpenClaw 能装载 Plugin/Skill/四个 typed Hook，并能注册 SSE 配置 |
| 全仓库离线门禁 | `npm run verify` | Spec、文档、安装图、密钥扫描、Skill 引用、向量组件和发布包一致性 |
| provider checker（开发） | `npm run verify:provider` | 仅对当前开发 endpoint 执行 initialize 与 `tools/list`；网络和服务必须真实可达 |
| provider checker（生产诊断） | `npm run verify:provider:prod` | 仅查看生产 endpoint 当前广告面，不产生业务写入 |
| 真实业务链 | 《高效联调测试指南》§4 | 真实 Agent → MCP → 开发库 → 测试企微 → 回收 → CSV → 新 session 恢复 |

旧 Python Hook 状态机已从当前验收门禁移除，也不进入发布包。`tests/test_hooks.py` 与 `YPmcn/hooks/*.py` 目前只保留为历史回归工件，需要考古时显式运行 `npm run test:legacy-hooks`；其结果不是当前执行面或 workflow 恢复证据。Skill、按需引用和文档一致性继续由 `npm run verify` 检查。

这些命令在当前 SHA 通过时，只能同时证明：

- `create_with_distributions` 首次调用只生成多行 AskUserQuestion；“确认发送”回调可在后续 assistant turn 到达，最新未过期本地回执直接放行下一次调用一次，不再校验后续参数，其他结果不发送。
- 禁止 shell/curl 绕过企微外发 Tool；普通读写 Tool 不进入本地权限门禁。
- Native Node Hook 的本地 phase/next_action 只是 Agent 编排权威；它不能伪造 Provider 成功、授予服务端动作或替代写幂等账本。
- 目标恢复顺序仍为 `sync → ingest → sync`；独立后端工作树已覆盖真实表查询、同一推荐项 inquiry upsert 与 `returned_not_ingested` 单测，只有部署后再通过新 session 聚合 Live E2E 才算真正恢复。
- tracked 文件和发布包的密钥扫描均为零发现；发布包不包含 mock、测试、源码、凭据或绝对路径。
- 任一 tgz 只代表其生成 SHA 的离线证据；版本号相同也不能自动继承另一提交的测试结论。

独立验证必须在实现提交冻结后由不同模型只读检查完整差异，复跑密钥扫描及关键测试，并把结果写入本任务 verification 工件。未完成前不得把本节解释为 Reviewer 已批准。

## 3. Provider 差距

开发机只读门禁：

```bash
npm run verify:provider
```

生产路由诊断：

```bash
npm run verify:provider:prod
```

旧开发 endpoint 与旧生产快照只保留为历史背景，不能作为统一 endpoint 的当前证据。开发与生产现在都由 `https://mcp.eshypdata.com/sse` 提供。2026-07-19 执行 `npm run verify:provider` 得到 `PASS`：15 个目标业务 Tool 齐全、输入 schema 无差异，schema hash 为 `60ce3e95214b52776e6b21e53b686c9ada50b3e381fca615b024682d2bc4768b`。后续验收仍须保存当次结果；若实时广告面不一致，应报告契约漂移，不得沿用本次结果判定通过。

检查器只发送 `initialize`、`notifications/initialized` 和 `tools/list`，不会调用业务 Tool。向量能力的当前目标是 `search_creators`/`rank_creators` 的服务端内部实现，不要求普通 Agent 看到 `search_creator_tag_vectors`；公开 vector Tool 是否出现不能作为这 15 个业务 Tool 的通过条件。只读 PASS 也不是完整生产业务链证据。

## 4. 尚需外部证明的数据库与后端不变量

`spec/database.json` 记录的是 2026-07-18 对开发库的真实只读观察，不是 migration 或 deployment proof。当前最小核对面是：

| 不变量 | 当前证据 | 放行证据 |
| --- | --- | --- |
| 达人身份使用 `(platform, kwUid)` | `development-observed` 快照 | 当前库的列、索引和跨表 join 样本 |
| 机构权威来自 `core_supplier` | `development-observed` 快照 | 当前 FK/唯一键和真实 supplier 映射样本 |
| 单达人预算不污染项目总预算 | 当前 MCP proxy 未强制 | validate 集成测试及历史数据核查 |
| 11 个写 Tool 持久化幂等 | 真实 ledger 仍为 0 行；独立后端工作树已接入 10 个本地写入口和外部创建入口，覆盖同 key 重放、hash 冲突、回滚及 unknown 禁止重试 | 部署后真实 ledger 行、并发和断线对账测试 |
| sync 读取发送方并维护 inquiry | `core_project/core_distribution/core_notificationlog` 查询已在真实库只读执行；本地源码按推荐项 `mcn_recommendation_id + attempt_no` upsert inquiry，重复 sync 单测通过 | 部署后真实 project/supplier 首次 sync、回收再 sync 与跨 session 恢复 |

本次已保存等价的 `information_schema.COLUMNS/STATISTICS` 只读证据。当前最小实现没有改任何表：本地事务直接复用 ledger，外部创建转发稳定 `Idempotency-Key`，超时记为 unknown 且不盲重发。由于外部 API 文档未承诺持久化该键，完整外部 exactly-once 仍需其接受并按键查询；不修改已敲定的 `customer_demands` 或 `field_match_mapping`。

## 5. 凭据处置

当前源码和发布包已无可识别硬编码凭据，但历史版本曾出现真实格式凭据。因此上线前仍必须完成一次独立的凭据轮换与撤销：

- 轮换数据库、provider/API、企微和向量服务相关凭据。
- 撤销历史凭据并检查最近使用记录，而不是只修改当前环境变量。
- 通过受控 secret store 注入新值；日志和验收材料只记录 key 名、轮换时间与责任人，不记录值。
- 轮换后重新运行 tracked 与 tarball 密钥扫描。

“当前扫描为零发现”只能证明新包干净，不能证明历史凭据仍然安全。

## 6. 精确上线门禁

只有以下条件全部满足，生产结果才能从 `NO-GO` 改为 `GO`：

1. **实现门禁**：独立后端工作树的 ledger/11 个写入口、inquiry sync、workflow 聚合和向量融合先部署到指定开发机；当前本地源码不放行生产。
2. **凭据门禁**：历史凭据已轮换、旧值已撤销，secret store 与审计记录可追溯。
3. **provider 契约门禁**：从实际部署环境保存当前 `tools/list`，包含验收所需的 15 个工具（原 14 个加 `get_workflow_state`），输入 schema 与 `mvp-v2` 一致；开发与生产检查分别返回 0，不能用 7 月 16 日快照代替。
4. **需求门禁**：字典不含客户内容，requirement/snapshot/selection 的 version/hash 可复算；canonical raw 冲突、金额/deadline/constraint 错误均 fail closed。
5. **状态门禁**：`get_workflow_state` 从已提交业务事实和 ledger 推导 phase/allowed actions；断链、冲突和 unknown 均 fail closed，新 session 恢复不依赖旧聊天或 Hook 文件。
6. **发送安全门禁**：未知结果当前已禁止重发；生产放行前外部 API 仍需明确接受并持久化唯一 key，或提供按 key 找回创建结果的只读接口。
7. **数据库门禁**：上节六项当前不变量均有当日 `SHOW` 证据、可解析 schema fragment、必要 migration/constraint/transaction 记录及并发测试。
8. **Algorithm 门禁**：`spec/algorithms.json` 从 `external-unverified` 进入单独批准并有独立验证；不得从当前代码或本 Requirements Spec 反推排名权重。
9. **完整链路门禁**：隔离租户完成 `validate/split → snapshot → search → rank MCN → persist selection → send operation → refresh → request → finalize → rank → submit → feedback`，并验证 recovery owner、late data 和 offer promotion 冲突。
10. **发布与灰度门禁**：最终提交重新运行 `npm run verify`、`npm run pack:yp` 和 tarball 密钥扫描；先受控灰度，观察重复发送、scope/join、状态冲突、迟到数据和晋升幂等指标。

任一门禁失败时，新链路保持关闭。不得通过放宽 schema、重新启用 mock 成功、跳过确认或回退到含凭据的旧包来换取“绿色”状态。

## 7. 回滚边界

- Hook 或插件行为异常时，回滚到上一安全发布包，同时关闭 v3 新链路。
- provider/数据库迁移按独立 Change Proposal 回滚；不得由插件自行改表或猜测兼容字段。
- 发生发送结果未知时，保留 send operation 与 correlation key 并走服务端 refresh 对账，不直接执行第二次发送。
- 本地 Hook 与测试工具任何时候都不能接管生产流量。
