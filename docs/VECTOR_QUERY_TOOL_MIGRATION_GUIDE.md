# 向量查询工具迁移指南

## 1. 目标

将当前仓库中的本地 `vector-mcp` 从“随 YPmcn 插件打包、在用户设备运行”的形态，迁移为由 YP 服务端统一托管的向量查询能力。

迁移完成后，用户只需安装 YPmcn 插件并连接远程 MCP，不需要安装 Qdrant、连接 MySQL，也不需要配置 DashScope 或数据库密钥。

目标架构：

```text
用户安装 YPmcn 插件
        ↓
插件连接 https://mcp.eshypdata.com/sse
        ↓
服务端 MCP 调用向量查询能力
        ↓
MySQL 只读数据 → DashScope → Qdrant → MySQL 回源 → Rerank
```

## 2. 当前状态

### 2.1 `vector-mcp` 是独立 MCP Server

当前 `vector-mcp`：

- 使用 stdio transport；
- 从 YP MySQL 的 `xhs_mz`、`dy_mz` 读取达人数据；
- 调用 DashScope `text-embedding-v4` 生成 1024 维向量；
- 向 Qdrant 写入和查询 `content`、`commercial` 双命名向量；
- 使用 DashScope `qwen3-rerank` 精排；
- 查询命中后回源 MySQL 执行硬条件过滤。

### 2.2 当前打包不等于可用

当前打包脚本会把以下目录复制进用户安装包：

```text
vector-mcp/dist/
```

相关位置：

- `scripts/prepare-package.mjs`；
- `YPmcn/package.json`。

但当前插件的 `YPmcn/mcp.json` 和 `YPmcn/.mcp.json` 只注册：

```text
https://mcp.eshypdata.com/sse
```

本地 `vector-mcp` 没有被注册为 MCP Server，安装包也没有完整包含其独立依赖和运行配置。即使继续打包，用户设备也无法安全获得 MySQL、Qdrant 和 DashScope 凭据。

因此，`vector-mcp/dist` 不应作为终端用户本地运行时继续打包。

## 3. 迁移原则

### 3.1 插件只做客户端

YPmcn 插件负责：

- 提供 Skill、Hook 和用户交互流程；
- 连接 YP 托管的远程 MCP；
- 调用公开的向量查询 Tool；
- 展示经过业务权限控制的查询结果。

插件不负责：

- 连接生产 MySQL；
- 保存 Qdrant API Key；
- 保存 DashScope API Key；
- 在用户设备生成或维护生产向量；
- 执行全量或增量数据同步。

### 3.2 基础设施密钥只保留在服务端

以下配置必须通过服务端 Secret Manager、部署平台密钥配置或受限环境变量注入：

```text
QDRANT_URL
QDRANT_API_KEY
QDRANT_COLLECTION
QDRANT_VECTOR_SIZE
VECTOR_VERSION

DASHSCOPE_API_KEY
DASHSCOPE_WORKSPACE_ID
DASHSCOPE_EMBEDDING_MODEL
DASHSCOPE_RERANK_MODEL

YP_MYSQL_HOST
YP_MYSQL_PORT
YP_MYSQL_USER
YP_MYSQL_PASSWORD
YP_MYSQL_DATABASE
```

禁止把这些密钥：

- 写入 Git；
- 写入插件配置；
- 打进 npm 包；
- 放入 Skill、Prompt 或日志；
- 交给终端用户；
- 通过 MCP Tool 返回。

终端用户如需鉴权，应使用 YP 用户账号对应的用户级 Token、Session 或 OAuth，不得使用基础设施密钥。

### 3.3 MySQL 是事实源

MySQL 是达人业务数据的唯一事实源，Qdrant 只保存可重建的派生向量索引。

不得在 Qdrant 中手工维护完整达人资料。查询命中后必须回源 MySQL 校验当前记录、业务权限和硬过滤条件。

## 4. 目标部署方案

推荐将向量能力合并进现有远程 MCP：

```text
https://mcp.eshypdata.com/sse
```

也可以独立部署为新的远程 MCP，但会增加服务发现、鉴权、监控和故障处理成本。没有明确隔离需求时，优先复用现有远程 MCP。

目标服务端组件：

```text
YP 远程 MCP
├── 媒介业务 Tool
├── 向量查询 Tool
├── MySQL 只读连接
├── DashScope Client
└── Qdrant Client
```

Qdrant 当前测试配置：

```text
QDRANT_URL=https://vs.eshypdata.com
QDRANT_COLLECTION=creator_vectors_v1_202607
QDRANT_VECTOR_SIZE=1024
VECTOR_VERSION=creator-v1
```

Collection schema：

```json
{
  "vectors": {
    "content": { "size": 1024, "distance": "Cosine" },
    "commercial": { "size": 1024, "distance": "Cosine" }
  }
}
```

Payload index：

```json
{
  "field_name": "platform",
  "field_schema": "keyword"
}
```

## 5. Tool 暴露与权限

### 5.1 业务查询 Tool

```text
search_creator_tag_vectors
```

用途：

- 根据项目需求或直接查询文本召回达人；
- 按平台查询 `xiaohongshu` 或 `douyin`；
- 回源 MySQL 做地区、粉丝量等硬过滤；
- 使用 reranker 输出最终候选。

该 Tool 可以开放给正常业务工作流，但必须继承 YP 的用户身份、租户权限、审计和限流规则。

### 5.2 健康检查 Tool

```text
health_check_vector_store
```

用途：

- 检查 Qdrant 是否可用；
- 检查 MySQL 是否已配置；
- 检查 embedding 和 reranker 配置。

建议只向运维、测试或内部诊断流程开放，不应返回密钥、连接字符串或数据库细节。

### 5.3 同步 Tool

```text
sync_creator_tag_vectors
```

用途：

- 从 MySQL 读取达人数据；
- 脱敏投影；
- 生成 embedding；
- 写入 Qdrant。

该 Tool 只能由后台任务、管理员或受控运维流程调用，不能开放给普通用户或由模型自由触发。

正式全量同步前必须解决：

1. 将单一 `update_time` 游标改为 `(update_time, kwUid)` 复合游标；
2. 明确稳定 Point ID 或历史快照隔离策略；
3. 实现下线达人和 stale Point 删除；
4. 增加 MySQL 与 Qdrant 对账；
5. 确保整批 upsert 成功后才推进游标。

## 6. 实施步骤

### 阶段一：服务端接入

1. 将 `vector-mcp` 的 runtime、查询 pipeline 和依赖部署到 YP 服务端；
2. 使用服务端环境变量注入 Qdrant、DashScope 和 MySQL 凭据；
3. MySQL 使用只读账号；
4. 固定使用 HTTPS Qdrant URL；
5. 在服务端 MCP 注册向量查询、健康检查和同步 Tool；
6. 为同步 Tool 增加管理员权限和调用审计。

### 阶段二：远程 MCP 联调

1. 调用 `health_check_vector_store`；
2. 确认 Qdrant、MySQL、embedding、reranker 可用；
3. 分别验证 `xiaohongshu`、`douyin` 查询；
4. 确认查询模式为 `local-vector`，且没有意外降级；
5. 验证 Qdrant 故障时可以降级为 SQL-only；
6. 确认日志不包含密钥、完整向量或敏感达人原文。

### 阶段三：调整插件打包

服务端远程查询验证通过后：

1. 从 `scripts/prepare-package.mjs` 移除 `vector-mcp/dist` 复制逻辑；
2. 从 `YPmcn/package.json` 的 `files` 中移除 `vector-mcp/dist/`；
3. 保留 `YPmcn/mcp.json` 和 `YPmcn/.mcp.json` 中的远程 MCP 配置；
4. 确认 Skill 调用的是远程 MCP 暴露的 Tool；
5. 重新执行打包和密钥扫描；
6. 在干净环境安装包并完成查询冒烟测试。

## 7. 用户开箱即用流程

迁移完成后的用户流程：

```text
安装 YPmcn 插件
→ 插件自动发现远程 ypmcn-mcp
→ 用户登录或使用已有 YP 身份
→ 用户提出达人筛选需求
→ Skill 调用 search_creator_tag_vectors
→ 服务端完成向量召回、MySQL 回源和精排
→ 返回业务候选
```

用户不需要：

- 安装 Qdrant；
- 配置数据库；
- 申请 DashScope Key；
- 理解 Collection；
- 手工同步向量；
- 维护本地 MCP 进程。

## 8. 运维与版本管理

### 日常检查

至少监控：

- MCP 请求成功率和延迟；
- Qdrant Collection 状态；
- 各平台 Point 数量；
- MySQL 与 Qdrant 对账差异；
- embedding、rerank 错误率；
- SQL-only 降级率；
- 同步批次、游标和失败记录。

### 模型或投影升级

Embedding 模型、向量维度、文本投影规则或 `VECTOR_VERSION` 变化时，必须新建版本化 Collection，例如：

```text
creator_vectors_v2_...
```

不得把不同模型或不同投影规则生成的向量混入同一 Collection。新 Collection 完成回填和评测后，通过配置或 alias 切流，并保留旧 Collection 作为短期回滚路径。

### 数据恢复

Qdrant 是可重建索引，不复制本地 Qdrant volume 作为迁移方式。发生数据损坏时，应从 MySQL 重新投影和生成向量。

## 9. 验收标准

迁移完成必须同时满足：

- 用户安装包不包含基础设施密钥；
- 用户安装包不依赖本地 `vector-mcp` 进程；
- 远程 MCP 可以发现并调用向量查询 Tool；
- `xiaohongshu`、`douyin` 真实检索均成功；
- 查询结果经过 MySQL 回源和业务过滤；
- 同步 Tool 对普通用户不可见或不可调用；
- Qdrant、DashScope 或 reranker 故障时有明确降级；
- 日志和错误不泄露密钥、完整向量或敏感原文；
- 打包产物通过密钥扫描；
- 干净环境安装后无需用户配置基础设施即可完成查询。

## 10. 回滚

迁移期间保留当前插件版本和旧 Collection，不直接删除。

如果远程向量查询出现问题：

1. 将查询切回 SQL-only；
2. 停止新的向量同步任务；
3. 保留 MySQL 业务流程；
4. 修复服务端后重新验证；
5. 不要求用户修改本地密钥或数据库配置。

回滚不应依赖用户重新安装 Qdrant 或恢复本地 `vector-mcp`。
