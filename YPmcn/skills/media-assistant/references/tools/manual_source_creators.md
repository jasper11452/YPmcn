# manual_source_creators

## 何时调用

机构回收完成后仍需真实人工来源补量，并已有可验证账号与来源时调用。

## 输入

必填 `requirement_id`、`manual_results`。每项至少包含 platform、platform_account_id、profile_url；报价、返点和备注按 schema 传。

## 输出成功证据

- success === true
- data.manual_batch_id
- data.imported_count

## 调用后必须停在哪里

展示导入数、拒绝/重复信息；保留 manual batch ID，随后按当前 recovered 证据精排。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。不得用虚拟账号、无来源 URL 或虚构报价补量。
