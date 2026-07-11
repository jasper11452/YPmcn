# get_creator_detail

## 何时调用

需要核对单个达人事实、报价、账号或风险证据时只读调用。

## 输入

必须且只能选择一种完整标识：`creator_id`，或 `platform` + `platform_account_id`。

## 输出成功证据

- success === true
- data.creator_id
- data.creator_detail

## 调用后必须停在哪里

查询不推进主链；把已确认事实用于展示或人工决策。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。不得混用两种标识，不得从昵称猜账号 ID。
