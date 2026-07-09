#!/usr/bin/env python3
"""
validate_requirement 传参精度自检脚本。

Agent 在调用 validate_requirement 前运行此脚本。
输入：待传入 validate_requirement 的 JSON 参数 + 用户原文（可选）
输出：{"ok": true} 或 {"ok": false, "errors": ["...", ...]}
"""

import json
import re
import sys


def check(params: dict, raw_text: str = "") -> list[str]:
    errors = []

    required_fields = (
        "platform",
        "submission_deadline_at",
        "raw_messages_json",
        "budget_min_cents",
        "budget_max_cents",
        "budget_raw",
        "rebate_min_rate",
        "rebate_raw",
        "quantity_total",
    )
    for field in required_fields:
        if params.get(field) is None or params.get(field) == "":
            errors.append(f"缺少必填字段: {field}")

    # 1. platform 枚举
    platform = params.get("platform")
    if platform is not None:
        if isinstance(platform, str):
            pl = platform.lower()
            if pl in ("xiaohongshu", "red", "小红书"):
                errors.append(f'platform="{platform}" 应改为 "xhs"（小红书）')
            elif pl in ("douyin", "抖音"):
                errors.append(f'platform="{platform}" 应改为 "dy"（抖音）')
            elif pl not in ("xhs", "dy"):
                errors.append(f'platform="{platform}" 不在允许范围: xhs, dy')

    # 1.5 submission_deadline_at 必须是 ISO 8601 格式
    ISO_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$')
    deadline = params.get("submission_deadline_at")
    if deadline is not None and isinstance(deadline, str) and not ISO_PATTERN.match(deadline):
        errors.append(f'submission_deadline_at="{deadline}" 不是有效 ISO 8601 带时区格式（如 2026-07-10T18:00:00+08:00）')

    # 2. 金额单位：分
    for field in ("budget_min_cents", "budget_max_cents"):
        val = params.get(field)
        if val is not None:
            if not isinstance(val, (int, float)):
                errors.append(f"{field} 应为数字，当前 {type(val).__name__}")
            elif isinstance(val, float) and val == int(val):
                pass  # 允许 3000000.0
            elif val <= 0:
                # 0 或负数：0 作为区间下界是合法的（如"3万以内"→ budget_min_cents=0），负数才是错误
                if val < 0:
                    errors.append(f"{field}={val} 不能小于 0")
            elif val < 100:  # 很可能是元而不是分
                errors.append(f"{field}={val} 看起来是元（太小），单位应为分。3万→3000000")
            elif val > 100_000_000:
                errors.append(f"{field}={val} 数值过大，检查是否单位错误")
    min_budget = params.get("budget_min_cents")
    max_budget = params.get("budget_max_cents")
    if isinstance(min_budget, (int, float)) and isinstance(max_budget, (int, float)) and min_budget > max_budget:
        errors.append("budget_min_cents 不能大于 budget_max_cents")

    # 3. 返点单位：小数
    for field in ("rebate_min_rate", "rebate_max_rate"):
        val = params.get(field)
        if val is not None:
            if not isinstance(val, (int, float)):
                errors.append(f"{field} 应为数字，当前 {type(val).__name__}")
            elif val > 1:
                errors.append(f'{field}={val} 看起来是百分比数值（>1），应为小数。20%→0.2，不是20')
            elif val < 0:
                errors.append(f"{field}={val} 不能小于 0")
    min_rebate = params.get("rebate_min_rate")
    max_rebate = params.get("rebate_max_rate")
    if isinstance(min_rebate, (int, float)) and isinstance(max_rebate, (int, float)):
        if min_rebate > max_rebate:
            errors.append("rebate_min_rate 不能大于 rebate_max_rate")

    # 4. 原文未提下限不应编造
    if raw_text and "预算" in raw_text and "以下" not in raw_text and "内" not in raw_text:
        min_val = params.get("budget_min_cents")
        if min_val is not None and min_val > 0:
            # 原文没明确下限但传了值，可能是编造的。这只是 warning，不阻断
            pass  # 让业务逻辑决定

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

    params = data.get("params", data)
    raw_text = data.get("raw_text", "")

    errors = check(params, raw_text)
    if errors:
        print(json.dumps({"ok": False, "errors": errors}))
        sys.exit(1)
    else:
        print(json.dumps({"ok": True}))
        sys.exit(0)


if __name__ == "__main__":
    main()
