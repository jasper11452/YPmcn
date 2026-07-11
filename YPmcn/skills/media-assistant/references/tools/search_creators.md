# search_creators

## 何时调用

仅在 requirement ready 且有当前会话 requirement ID 时调用。

## 输入

必填 `requirement_id`，值来自 validate_requirement.data.id。

## 输出成功证据

- success === true
- data.id
- data.candidate_pool_written

data.id 记录为 candidate_pool_id。

## 调用后必须停在哪里

进入 `candidate_pool_ready`，展示候选数量与供给缺口，再调用 `rank_mcns`。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。ID 不匹配、候选池未写入或结果未知时停止并对账。
