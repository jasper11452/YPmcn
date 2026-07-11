# create_submission_batch

## 何时调用

精排成功并形成当前 run 后调用；服务端复用当前未完成批次以避免重复。

## 输入

必填 `run_id`，值来自 rank_creators.data.run_id。

## 输出成功证据

- success === true
- data.id
- data.batch_no
- data.submitted_count

## 调用后必须停在哪里

进入 `submission_batch_ready`，展示批次号和数量，等待客户反馈。

## 错误与停止条件

禁止 `demand_id`、`demand_version`、`allow_need_confirm_with_risk`。run 不匹配或写结果未知时先查详情，不新建第二批。
