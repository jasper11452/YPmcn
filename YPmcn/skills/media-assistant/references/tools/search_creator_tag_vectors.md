# search_creator_tag_vectors

## 何时调用

远程 Provider 已在 `tools/list` 广告该工具，且需要按项目语义、内容标签或商业标签补充达人召回时调用。

## 输入

必填 `positiveRequirements`、`negativeRequirements`。可选 `platform`、`queryText`、`projectId`、`limit`、`candidateLimit`、地区、粉丝、价格和合规硬过滤字段。平台只使用 `xiaohongshu` 或 `douyin`。

## 输出成功证据

- 实际返回 `success === true`
- actual results include MySQL revalidation provenance
- degraded responses include an explicit degraded reason

## 调用后必须停在哪里

该工具只提供查询候选，不推进业务 phase；后续业务写入仍按主链调用 `search_creators`、`rank_mcns` 等工具。

## 能力边界

`search_creator_tag_vectors` 是迁移中的远程公开查询能力。`sync_creator_tag_vectors` 与 `health_check_vector_store` 属于运维面，普通 Agent 不得调用。远程工具缺失时继续使用 `search_creators`，不得连接本地 vector MCP、基础设施或模拟向量结果。

## 错误与停止条件

工具未广告、结果缺少 MySQL 回源证明、硬条件未校验或降级原因不明确时，停止使用该结果并返回 `integration_required`。
