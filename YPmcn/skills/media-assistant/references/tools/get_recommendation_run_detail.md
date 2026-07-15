# get_recommendation_run_detail

## 何时调用

只读核对推荐运行、提报或反馈事实时调用。

## 输入

必填 `run_id`；可选 `include_submissions`、`include_creator_detail`、`include_feedback`。字符串值必须表示正整数。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

查询本身不推进流程，只为下一安全动作提供证据。

## 错误与停止条件

无效或非正整数 run ID 时停止；查询不到不得补造历史状态。
