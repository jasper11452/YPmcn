# 询价字段绑定

`select_inquiry_form_fields` 参数为 `url: "https://agenta.eshypdata.com/demand-field-selector"`，不传 `platform`。宿主只打开工具返回的 `...?callback` 前缀链接；不提前打开、重试或探测状态。仅当成功且 `description` 各非空行能按全角或半角冒号拆成非空、唯一的“数据库字段名：备注”时，才按原序展示并确认。

生成 `columns`：字段名→必填 `key`，备注→必填 `name`；每项只保留这两个字段。旧 `field_key`/`field_name` 改名，并丢弃 `type`、`required`、`group` 等其他元数据。不得猜 `fields/items/count` 或根据标签映射字段。选择不发送、不推进 phase。
