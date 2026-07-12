# Impact Analysis：CHG-2026-002

## Change Summary

- 变更内容：删除旧 DB-backed MockMCP、直接企微发送代码、假向量索引、敏感来源资料、历史文档、生成物和旧分支。
- 变更原因：这些内容已被 v3 Spec/provider/reference MCP/vector MCP 取代，继续保留会造成双入口、误操作风险和维护噪声。
- 风险等级：High。正式契约与当前运行时不变，但会删除真实副作用旧工具、用户本地资料并改写全部保留分支的提交 SHA。

## Contract Changes

- Database Spec：不变。
- MCP Spec：不变。
- Skill / Hook / Workflow / Error Spec：不变。
- Algorithm Spec：状态和引用不变；保留其唯一来源 Alias。
- 兼容性检测：`spec/profiles/legacy-1.9.4.json` 保留，生产 provider 检测能力不变。

## Affected Files

| 路径 | 处理 | 影响 |
|---|---|---|
| `mock-mcp.mjs` | 删除 | 移除旧 2.1.x DB/后端写入口 |
| `src/send_wecom.mjs`、`YPmcn/src/send_wecom.mjs` | 删除 | 移除无当前消费者的重复企微发送实现 |
| `scripts/test-wecom-send.mjs` | 删除 | 移除可手工产生真实企微/DB 副作用的脚本 |
| `scripts/build-vector-index.mjs` | 删除 | 移除已废弃的 128 维假向量构建路径 |
| `tests/secret_scan.test.mjs` | 修改 | 将旧入口的 fail-closed 检查改为不存在性回归 |
| `tests/test_skill_package.py`、`docs/integration-readiness.md` | 修改 | 同步删除两项旧 Mock 测试后的验证计数 |
| `doc/客户原始需求列表.csv` | 删除 | 移除完整客户 Brief/payload 数据 |
| `doc/*的替身` | 删除七个、保留一个 | 删除无引用且不可移植的 Alias；算法来源引用不断裂 |
| `docs/superpowers/**`、`docs/requirements/**` | 删除 | 移除历史计划与 draft 需求，避免冒充当前事实源 |
| 三份旧实现/迁移文档 | 删除 | 移除过时 MockMCP、假向量和未批准数据库操作指引 |
| `src/README.md`、根 `README.md` | 新增/修改 | 明确根源码目录当前不承载独立运行时 |
| ignored 生成物与 Git refs | 删除 | 不影响可复现源码；降低磁盘和导航噪声 |
| 保留分支 Git 历史 | 定向改写 | 仅移除完整客户需求 CSV；全部提交 ID 随之变化 |

## Dependency and Runtime Impact

- 当前插件入口只构建 `YPmcn/src/index.ts` 及其 TypeScript 依赖；删除的 `YPmcn/src/send_wecom.mjs` 不在依赖图和发布包中。
- 根旧 Mock 仅被将同步删除的手工脚本、旧文档和两项安全测试引用。
- `reference-mcp/` 继续提供无网络模拟；`vector-mcp/` 继续提供当前向量实现。
- 删除 `node_modules` 与 `dist` 只影响本地增量速度；锁文件和源码足以重建。

## Data and Security Impact

- 不读取、复制或输出 CSV 中的客户内容；只删除文件。
- 仓库暂无 remote；对 `main` 与 portable archive 的全部可达历史定向移除客户 CSV，再删除 backup refs、过期 reflog 和不可达对象。
- 不创建包含客户 CSV 的 bundle、tag 或备份分支。净化前后的当前树摘要必须一致；portable 分支除该 CSV 外的清单摘要必须一致。
- 删除直发企微和 DB-backed Mock 后，误执行真实副作用的本地入口减少。

## Validation

- 删除前测试锁定旧入口必须不存在。
- 全量 `npm run verify` 覆盖 Spec 治理、密钥扫描、插件、reference MCP、Skill 文档、vector MCP 和发布包。
- `npm run pack:yp` 证明删除项不属于当前发布运行时。
- OpenCode 基于冻结提交执行不同上下文的只读验证。
- 最终检查 Git worktree、branch、ignored 目录和发布目录状态。
- Git 对象清单中不得再出现客户 CSV 路径，且净化前记录的 blob 必须不可读取。

## Rollback

- tracked 变更可整体 revert。
- 生成物按锁文件重建，不作为回滚资产保存。
- 不通过回滚恢复客户完整需求 CSV、旧直发脚本或过期本地凭据入口；确有业务需求时需发起新的安全评审。
- 历史 SHA 改写不可通过保留旧 ref 回滚，否则会重新暴露客户数据；外部引用应以净化后的 SHA 为准。

## Open Questions

- 无。仓库无 remote，用户已批准删除清单，历史净化在本地完成。
