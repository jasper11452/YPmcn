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
    "confirm_structured_brief",     # 弹窗确认
    "search_creators",
    "confirm_supply_ratio",         # 弹窗：MCN/野生比例
    "rank_mcns",                    # MCN 排序（MCP 工具）
    "confirm_mcn_list",             # 弹窗：MCN 名单选择
    "confirm_form_fields",          # 弹窗：表单字段
    "confirm_wecom_permission",     # 弹窗：角色权限
    "confirm_send_content",         # 弹窗：发送内容
    "create_with_distributions",
    "confirm_proceed_ranking",      # 弹窗：是否精排
    "rank_creators",
    "confirm_risky_submission",     # 弹窗：风险账号（有条件）
    "create_submission_batch",
]

# 每个步骤允许的下一个动作
NEXT_ALLOWED = {
    "validate_requirement": ["confirm_structured_brief", "validate_requirement"],
    "confirm_structured_brief": ["search_creators", "validate_requirement"],
    "search_creators": ["confirm_supply_ratio"],
    "confirm_supply_ratio": ["rank_mcns"],
    "rank_mcns": ["confirm_mcn_list"],
    "confirm_mcn_list": ["confirm_form_fields"],
    "confirm_form_fields": ["confirm_wecom_permission"],
    "confirm_wecom_permission": ["confirm_send_content"],
    "confirm_send_content": ["create_with_distributions"],
    "create_with_distributions": ["confirm_proceed_ranking"],
    "confirm_proceed_ranking": ["rank_creators"],
    "rank_creators": ["confirm_risky_submission", "create_submission_batch"],
    "confirm_risky_submission": ["create_submission_batch"],
    "create_submission_batch": ["record_client_feedback"],
}

# 弹窗工具映射：弹窗名 → 对应的 MCP 工具
POPUP_TO_TOOL = {
    "confirm_structured_brief": None,    # askuserquestion
    "confirm_supply_ratio": None,
    "confirm_mcn_list": None,
    "confirm_form_fields": None,
    "confirm_wecom_permission": None,
    "confirm_send_content": None,
    "confirm_proceed_ranking": None,
    "confirm_risky_submission": None,
}


def check(current_phase: str, intent_tool: str, visited: list[str]) -> list[str]:
    errors = []

    # 检查是否已走过正确路径
    if intent_tool == "validate_requirement":
        return errors  # 任何时候都可以重新校验

    # 如果意图是弹窗确认（askuserquestion），检查对应工具
    if intent_tool.startswith("confirm_"):
        if intent_tool not in FLOW:
            return [f"未知弹窗模式: {intent_tool}"]
        return errors  # 弹窗可以随便发

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
