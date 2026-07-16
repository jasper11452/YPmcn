# get_creator_detail

## 何时调用

只读核对单个达人事实、报价或风险时调用。

## 输入

必填 `platform`、`kw_uid`；可选 `include_offers`、`include_mcn`、`include_vector_text`、`include_recent_metrics`。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

查询不推进主链，只展示已确认事实。

## 能力边界

只查询现有数据库中的单个达人，不打开浏览器补资料。字段缺失、过期或来源冲突必须显式展示，不把缺失当作零或不合格。

## 错误与停止条件

不得发送旧 `creator_id` 或 `platform_account_id`，不得从昵称猜 `kw_uid`。
