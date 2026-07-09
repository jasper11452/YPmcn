#!/usr/bin/env python3
"""
create_with_distributions 分发前全链路自检。

Agent 在调用 create_with_distributions 前运行此脚本。
检查所有前置确认是否已完成。
"""

import json
import sys

REQUIRED_GATES = [
    "structured_brief_confirmed",
    "supply_ratio_confirmed",
    "mcn_list_confirmed",
    "form_fields_confirmed",
    "wecom_permission_confirmed",
    "send_content_confirmed",
]


def check(gate_state: dict, params: dict) -> list[str]:
    errors = []

    # 检查 gate 状态
    for gate in REQUIRED_GATES:
        if not gate_state.get(gate):
            errors.append(f"前置确认未完成: {gate}")

    # 检查必要参数
    if not params.get("id"):
        errors.append("缺少 id（来自 rank_mcns.data.id 的 MCN 排序方案 ID）")

    if not params.get("deadline") and not params.get("remindAt"):
        errors.append("缺少 deadline 或 remindAt")

    # deadline 格式
    deadline = params.get("deadline") or params.get("remindAt") or ""
    if deadline and "T" not in deadline:
        errors.append(f"deadline={deadline} 不是 ISO 8601 格式（缺少 T）")
    if deadline and "Z" not in deadline and "+" not in deadline and "-" not in deadline[-5:]:
        errors.append(f"deadline={deadline} 缺少时区")

    # supplierIds
    sids = params.get("supplierIds") or params.get("supplier_ids")
    if not sids:
        errors.append("缺少 supplierIds")
    elif not isinstance(sids, list) or not all(isinstance(s, str) and s.strip() for s in sids):
        errors.append("supplierIds 必须是非空字符串数组")

    # usageScope
    scope = None
    if params.get("usageScope"):
        scope = params["usageScope"]
    elif isinstance(params.get("project"), dict):
        scope = params["project"].get("usageScope") or params["project"].get("usage_scope")
    if scope and scope not in ("project", "项目"):
        errors.append(f"usageScope 应为 project 或 项目，当前为 {scope}")

    # prefill rows by supplier
    prefill_by_supplier = (
        params.get("prefillRowsBySupplier")
        or params.get("prefill_rows_by_supplier")
        or params.get("talentRowsBySupplier")
        or params.get("talent_rows_by_supplier")
    )
    if prefill_by_supplier is not None:
        if not isinstance(prefill_by_supplier, dict):
            errors.append("prefillRowsBySupplier 必须是按 supplierId 分组的对象")
        elif isinstance(sids, list):
            extra = [sid for sid in prefill_by_supplier.keys() if sid not in sids]
            if extra:
                errors.append(f"prefillRowsBySupplier 包含不在 supplierIds 中的供应商: {extra}")

    # preview_only 检查
    if params.get("preview_only") is True:
        pass  # preview 模式放行
    elif not errors:
        pass  # 正式发送，确认前面都过了

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

    gate_state = data.get("gate_state") or {}
    params = data.get("params") or {}
    # 也支持扁平输入（直接传 tools/call 参数）
    if "deadline" in data and not params:
        params = data
    if "confirmed_gates" in data:
        for g in data.get("confirmed_gates", []):
            if g not in gate_state:
                gate_state[g] = True

    errors = check(gate_state, params)
    if errors:
        print(json.dumps({"ok": False, "errors": errors}))
        sys.exit(1)
    else:
        print(json.dumps({"ok": True}))
        sys.exit(0)


if __name__ == "__main__":
    main()
