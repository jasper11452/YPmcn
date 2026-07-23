# 手工拓展达人：当前流程与边界

> 适用版本：`3.4.25`。本文替代旧的“`target_count` + 先 `rank_mcns`”方案；那套设计只保留在 Git 历史中，不能按它执行。

## 先看结论

当前公开 Tool 是 `manual_source_creators`，唯一业务输入为：

```json
{
  "requirement_id": "<刚刚 validate_requirement 返回的 32 位 data.id>",
  "size": "12"
}
```

- `size` 是正整数字符串，例如 `"12"`，不是 `target_count`，也不是数字 `12`；
- `requirement_id` 是本次校验刚返回的 `data.id`，不是 `demand_id`、`demand_version` 或旧会话里的 ID；
- 一次校验结果只授权紧随其后的一次手工拓展调用；
- 写入结果未知时不盲重试；先对账，不能对账就停止。

## 为什么规则这么严格

手工拓展会写入候选和供给数据。若复用旧需求 ID，可能把达人写到另一版需求；若网络超时后直接重发，可能重复创建任务或重复入池。因此“最新校验结果 + 一次调用”是身份绑定，不是多余步骤。

举例：

```text
正确：validate_requirement → 返回 data.id=aaaaaaaa... → manual_source_creators(aaaaaaaa..., "12")
错误：拿上周的 demand_id，或把 “补 12 人” 写成 target_count: 12
```

## 两条可走的流程

### A. 尚未开始搜索：可直接拓展

适合用户一开始就明确说“先人工补 12 位达人”。流程是：

```text
完整 Brief
→ validate_requirement
→ 取得本次 data.id
→ manual_source_creators(requirement_id, size)
→ 收到非空达人列表
→ rank_creators
→ 等待批次导出契约发布
```

最小示例：

```json
// validate_requirement 的实际成功结果中
{"data":{"id":"0123456789abcdef0123456789abcdef"}}

// 紧邻的手工拓展调用
{"requirement_id":"0123456789abcdef0123456789abcdef","size":"12"}
```

成功不能只看一条“已生成 Excel”。当前本地消费规则要求实际响应里有非空 `creators`、`creator_list` 或 `manual_sourced_creators` 数组，随后立刻逐行展示平台、达人 ID、昵称、内容标签和主页链接。只有文件路径时，达人是否真正入池仍未得到证据。

### B. 已开始 `search_creators`：不能插队

一旦已经搜索，手工拓展必须等当前 MCN 分支走完：

```text
validate_requirement
→ search_creators
→ rank_mcns
→ 用户在网页中选择询价字段
→ create_with_distributions（先弹企微外发确认）
→ 用户明确确认后，一次性调用 Provider
→ 仅对实际 sent 的机构执行 sync_mcn_inquiry_status
→ 再次 validate_requirement
→ manual_source_creators
```

这里的“走完”指拿到每一步需要的真实证据，不是本地状态写了下一步就算完成。当前 `sync_mcn_inquiry_status` 仍有 Provider 能力缺口；如果它不能完成所需同步，流程应停在集成等待，不能为了继续手工拓展而跳过。

## 和企微外发的关系

在搜索已经开始的分支里，`create_with_distributions` 不是直接发出。每次真正外发前，Hook 都会拦截 MCP 调用并给出精确的 `AskUserQuestion`：内容包含机构、回填字段和企微正文。宿主必须原样显示；用户选择“确认发送”后，最新未过期回执可跨 turn 只放行下一次调用一次，之后立即消费。当前实现不会再核对下一次调用参数是否与弹窗完全相等，因此这份回执绝不是长期授权；再次发送或逐机构 fallback 都要重新确认。

用户取消、拒绝、关闭、超时或回调失败时不调用 Provider。宿主没有 session 上下文时，插件只使用自己的全局 fallback 回执，不会借用任何 session 的确认。

例如，先向 A、B 两家机构确认并发送，A 已发送、B 未绑定时，对 B 的单独 fallback 会重新弹出只包含 B 的确认；不能把前一次回执拿来连续发送。无论用户已确认与否，只有实际响应中每个机构都有可关联的明确 `sent` 状态，才可认为该机构已发送并传给同步 Tool。`success: true`、请求里的机构列表、汇总名单或 `sync_mcn_inquiry_status` 成功都不够。结果未知时停止，不要自动再发。

## 拓展后如何进入排序

| 情况 | `rank_creators` 的 `inquiry_ids` |
| --- | --- |
| 没有已验证的企微发送结果 | 省略或传 `null`。 |
| 有已验证的发送结果且返回了可用 inquiry ID | 只传最近一个可用 ID 的单元素数组。 |
| 有发送记录但还没人确认机构回填完成 | 先弹“机构回填确认”，不要合并排序。 |

`rank_creators` 同样是业务写，未知结果不能盲重试。当前远端没有稳定成功 outputSchema，实际响应需要保留为这次排序的唯一证据。

排序完成后，目标流程本应调用 `create_submission_batch` 导出首批名单；但当前 Provider 的入参与批准契约不兼容，因此运行时会返回 `integration_required`。不能填造 `submission_batche_page` 或 `columns` 强行导出。

## 常见误用

| 误用 | 为什么不行 | 正确做法 |
| --- | --- | --- |
| 传 `target_count` | 这是历史方案字段，当前远端不接受。 | 传 `size: "正整数"`。 |
| 传 `data.demand_id` | 它不是当前 Tool 的一次性主键。 | 传本次 `validate_requirement.data.id`。 |
| 搜索后立刻手工拓展 | 会绕过 MCN、字段选择、企微发送与同步证据。 | 先完成当前 MCN 分支；不能完成则停住。 |
| 只有 Excel 路径就说“拓展成功” | 缺少实际达人行，无法证明入池。 | 等待非空达人数组并逐行展示。 |
| 超时后直接再调 | 写入或外部结果可能已经发生。 | 保留响应并先做权威对账。 |

## 相关事实源

- 当前 Tool 输入与调用限制：[manual_source_creators.json](../YPmcn/skills/media-assistant/references/tools/manual_source_creators.json)
- 阶段、顺序和阻断条件：[spec/workflow.json](../spec/workflow.json)
- 远端真实 tools/list 与安全 probe：[MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)

若要改变这条流程，应先更新 Spec 与 Tool reference，再修改 Hook/Skill 和测试；不要只改提示词或文档。
