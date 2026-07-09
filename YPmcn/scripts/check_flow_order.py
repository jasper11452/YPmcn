#!/usr/bin/env python3
"""
流程顺序自检脚本。

Agent 在每次调用业务工具前运行此脚本。
输入：当前阶段 + 意图调用的工具名
输出：{"ok": true} 或 {"ok": false, "errors": ["...", "..."]}
"""

import json
import sys

# 正确顺序（每步完成才能走到下一步）
FLOW = [
    "validate_requirement",
    "confirm-extra-field-mapping",  # 弹窗：额外需求字段映射（如有）
    "confirm-structured-brief",     # 弹窗确认
    "search_creators",
    "rank_mcns",                    # MCN 排序（MCP 工具）
    "confirm-supply-ratio",         # 弹窗：MCN/野生比例
    "mcn-select-for-wechat",        # 弹窗：MCN 名单选择
    "confirm-form-fields",          # 弹窗：表单字段
    "confirm-wecom-permission",     # 弹窗：角色权限
    "mcn-wechat-send",              # 弹窗：发送内容
    "create_with_distributions",
    "wait_mcn_return_and_manual_source",  # 等待机构回填/手扒回收到候选池
    "ingest_mcn_submissions",       # MCN 回填导入
    "manual_source_creators",       # 手扒结果导入
    "confirm-ranking-after-supply-ready", # 弹窗：确认对候选池精排
    "rank_creators",
    "confirm-risky-submission",     # 弹窗：风险账号（有条件）
    "create_submission_batch",
    "record_client_feedback",       # 客户反馈
]

LEGACY_STEP_ALIASES = {
    "confirm_extra_field_mapping": "confirm-extra-field-mapping",
    "confirm_structured_brief": "confirm-structured-brief",
    "confirm_supply_ratio": "confirm-supply-ratio",
    "confirm_mcn_list": "mcn-select-for-wechat",
    "confirm_form_fields": "confirm-form-fields",
    "confirm_wecom_permission": "confirm-wecom-permission",
    "confirm_send_content": "mcn-wechat-send",
    "confirm_ranking_after_supply_ready": "confirm-ranking-after-supply-ready",
    "confirm_risky_submission": "confirm-risky-submission",
}

# 每个步骤允许的下一个动作
NEXT_ALLOWED = {
    "validate_requirement": ["confirm-extra-field-mapping", "confirm-structured-brief", "validate_requirement"],
    "confirm-extra-field-mapping": ["confirm-structured-brief", "validate_requirement"],
    "confirm-structured-brief": ["search_creators", "validate_requirement"],
    "search_creators": ["rank_mcns"],
    "rank_mcns": ["confirm-supply-ratio"],
    "confirm-supply-ratio": ["mcn-select-for-wechat"],
    "mcn-select-for-wechat": ["confirm-form-fields"],
    "confirm-form-fields": ["confirm-wecom-permission"],
    "confirm-wecom-permission": ["mcn-wechat-send"],
    "mcn-wechat-send": ["create_with_distributions"],
    "create_with_distributions": ["wait_mcn_return_and_manual_source"],
    "wait_mcn_return_and_manual_source": ["ingest_mcn_submissions", "manual_source_creators", "confirm-ranking-after-supply-ready"],
    "ingest_mcn_submissions": ["confirm-ranking-after-supply-ready", "manual_source_creators", "ingest_mcn_submissions"],
    "manual_source_creators": ["confirm-ranking-after-supply-ready", "ingest_mcn_submissions", "manual_source_creators"],
    "confirm-ranking-after-supply-ready": ["rank_creators"],
    "rank_creators": ["confirm-risky-submission", "create_submission_batch"],
    "confirm-risky-submission": ["create_submission_batch"],
    "create_submission_batch": ["record_client_feedback"],
    "record_client_feedback": ["rank_creators", "validate_requirement", "create_submission_batch"],
}

# 弹窗工具映射：弹窗名 → 对应的 MCP 工具
POPUP_TO_TOOL = {
    "confirm-extra-field-mapping": None,
    "confirm-structured-brief": None,    # askuserquestion
    "confirm-supply-ratio": None,
    "mcn-select-for-wechat": None,
    "confirm-form-fields": None,
    "confirm-wecom-permission": None,
    "mcn-wechat-send": None,
    "confirm-ranking-after-supply-ready": None,
    "confirm-risky-submission": None,
}


def canonical_step(step: str) -> str:
    return LEGACY_STEP_ALIASES.get(step, step)


def check(current_phase: str, intent_tool: str, visited: list[str]) -> list[str]:
    errors = []
    intent_tool = canonical_step(intent_tool)
    visited = [canonical_step(step) for step in visited]

    # 检查是否已走过正确路径
    if intent_tool == "validate_requirement":
        return errors  # 任何时候都可以重新校验

    # 如果意图是弹窗确认（askuserquestion），检查对应工具
    if intent_tool.startswith("confirm-") or intent_tool.startswith("mcn-"):
        if intent_tool not in FLOW:
            return [f"未知弹窗模式: {intent_tool}"]
        # 弹窗也是流程节点，必须按 NEXT_ALLOWED 顺序推进。

    # 检查意图是否在流程中
    if intent_tool not in FLOW:
        return errors  # data_query 类的不在流程中

    # 找到已完成步骤中最后一步
    last_step = None
    for v in reversed(visited):
        if v in FLOW:
            last_step = v
            break

    if last_step is None:
        # 还没开始，第一步必须是 validate_requirement
        if intent_tool != "validate_requirement":
            errors.append(f"第一条业务工具必须是 validate_requirement，不是 {intent_tool}")
        return errors

    # 检查下一步是否合法
    allowed = NEXT_ALLOWED.get(last_step, [])
    if intent_tool not in allowed:
        allowed_str = " → ".join(allowed)
        errors.append(f"当前阶段 {last_step}，不允许直接调用 {intent_tool}。先完成: {allowed_str}")

    return errors


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"ok": False, "errors": ["无输入"]}))
        sys.exit(1)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "errors": [f"JSON 解析失败: {e}"]}))
        sys.exit(1)

    current_phase = data.get("current_phase", "")
    intent_tool = data.get("intent_tool", "")
    visited = data.get("visited_steps", [])

    # 检查 intent_tool 本身来源
    if not intent_tool:
        print(json.dumps({"ok": False, "errors": ["缺少 intent_tool"]}))
        sys.exit(1)

    errors = check(current_phase, intent_tool, visited)
    if errors:
        print(json.dumps({"ok": False, "errors": errors}))
        sys.exit(1)
    else:
        print(json.dumps({"ok": True}))
        sys.exit(0)


if __name__ == "__main__":
    main()
