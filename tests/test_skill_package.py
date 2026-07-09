import csv
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "YPmcn"
SKILL = PACKAGE / "skills" / "media-assistant" / "SKILL.md"
REFERENCES = SKILL.parent / "references"
SCHEMA = REFERENCES / "creator_candidate_pool_schema.csv"
CSV_PATH = ROOT / "doc" / "客户原始需求列表.csv"
GOLDENS_PATH = ROOT / "tests" / "goldens" / "requirement_cases.json"
REGRESSIONS_PATH = ROOT / "tests" / "goldens" / "requirement_regressions.json"

EXPECTED_REFERENCES = {
    "requirement-intake.md",
    "requirement-parsing.md",
    "mcp-tool-routing.md",
    "workflow-state-machine.md",
    "frontend-response.md",
    "hook-behavior.md",
    "validation-playbook.md",
    "form-field-mapping.md",
}

EXPECTED_TOOL_CARDS = {
    "validate_requirement.md",
    "search_creators.md",
    "rank_mcns.md",
    "manual_source_creators.md",
    "ingest_mcn_submissions.md",
    "rank_creators.md",
    "create_submission_batch.md",
    "record_client_feedback.md",
    "audit_manual_adjustment.md",
    "get_creator_detail.md",
    "get_recommendation_run_detail.md",
    "create_with_distributions.md",
}

ROUTED_REFERENCES = {
    "requirement-intake.md",
    "requirement-parsing.md",
    "mcp-tool-routing.md",
    "workflow-state-machine.md",
    "frontend-response.md",
    "hook-behavior.md",
}

EXPECTED_TOOLS = {
    "validate_requirement",
    "search_creators",
    "rank_mcns",
    "manual_source_creators",
    "ingest_mcn_submissions",
    "create_with_distributions",
    "rank_creators",
    "create_submission_batch",
    "record_client_feedback",
    "audit_manual_adjustment",
    "get_creator_detail",
    "get_recommendation_run_detail",
}

BLOCKING_FIELDS = {
    "platform",
    "raw_messages_json",
    "budget_min_cents",
    "budget_max_cents",
    "budget_raw",
    "rebate_min_rate",
    "rebate_max_rate",
    "rebate_raw",
    "quantity_total",
    "submission_deadline_at",
}


SOURCE_SUFFIXES = {".md", ".json", ".ts", ".mjs"}
IGNORED_SOURCE_PARTS = {"node_modules", "dist"}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def source_files():
    for path in PACKAGE.rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        rel_parts = set(path.relative_to(PACKAGE).parts)
        if rel_parts & IGNORED_SOURCE_PARTS:
            continue
        yield path


class SkillPackageTest(unittest.TestCase):
    def test_package_contains_openclaw_runtime_files(self):
        required = {
            "openclaw.plugin.json",
            "package.json",
            "tsconfig.json",
            "src/index.ts",
            "tests/hooks.test.mjs",
            "README.md",
            "skills/media-assistant/SKILL.md",
            *(f"skills/media-assistant/references/{name}" for name in EXPECTED_REFERENCES),
        }
        actual = {
            path.relative_to(PACKAGE).as_posix()
            for path in PACKAGE.rglob("*")
            if path.is_file() and "node_modules" not in path.relative_to(PACKAGE).parts
        }
        self.assertTrue(required.issubset(actual))
        self.assertFalse((PACKAGE / ".workbuddy-plugin").exists())
        self.assertFalse((PACKAGE / "HOOK.md").exists())

    def test_openclaw_manifest_is_valid(self):
        manifest = json.loads(read(PACKAGE / "openclaw.plugin.json"))
        self.assertEqual("ypmcn-media-assistant", manifest["id"])
        self.assertEqual(["./skills"], manifest["skills"])
        self.assertEqual("object", manifest["configSchema"]["type"])
        self.assertNotIn(".workbuddy-plugin", json.dumps(manifest, ensure_ascii=False))
        self.assertNotIsInstance(manifest.get("contracts"), list)

    def test_yp_action_install_artifact_matches_plugin_identity(self):
        manifest = json.loads(read(PACKAGE / "openclaw.plugin.json"))
        package = json.loads(read(PACKAGE / "package.json"))
        package_lock = json.loads(read(PACKAGE / "package-lock.json"))
        claude_plugin = json.loads(read(PACKAGE / ".claude-plugin" / "plugin.json"))
        self.assertEqual(manifest["id"], package["name"])
        self.assertEqual(package["version"], manifest["version"])
        self.assertEqual(package["version"], package_lock["version"])
        self.assertEqual(package["version"], package_lock["packages"][""]["version"])
        self.assertEqual(package["version"], claude_plugin["version"])
        self.assertIn("pack:yp", package["scripts"])
        self.assertIn("npm run build", package["scripts"]["pack:yp"])
        self.assertIn("npm pack --pack-destination ..", package["scripts"]["pack:yp"])
        expected_archive = f'{manifest["id"]}-{package["version"]}.tgz'
        self.assertIn(expected_archive, read(PACKAGE / "README.md"))
        self.assertIn("不要直接填写源码目录", read(PACKAGE / "README.md"))

    def test_package_json_declares_runtime_build_and_test(self):
        package = json.loads(read(PACKAGE / "package.json"))
        self.assertEqual("module", package["type"])
        self.assertEqual("./dist/index.js", package["main"])
        self.assertEqual("tsc", package["scripts"]["build"])
        self.assertIn("node --test", package["scripts"]["test"])
        self.assertIn("openclaw", package["peerDependencies"])
        self.assertIn("typescript", package["devDependencies"])
        self.assertEqual(["./dist/index.js"], package["openclaw"]["extensions"])

    def test_runtime_registers_openclaw_hooks(self):
        text = read(PACKAGE / "src" / "index.ts")
        for required in (
            "definePluginEntry",
            "registerHooks",
            "runBeforeToolCallGuards",
            "responseContractGuard",
            "rewriteInvalidToolResult",
            '"before_tool_call"',
            '"after_tool_call"',
            '"tool_result_persist"',
            "validateProtocolEnvelope",
            "validateStateGuard",
            "validateHighRiskGuard",
            "validateProjectDistributionBeforeRanking",
        ):
            self.assertIn(required, text)

    def test_main_skill_is_a_stage_router(self):
        text = read(SKILL)
        match = re.search(r"^---\n.*?^description:\s*(.+?)\n---", text, re.M | re.S)
        self.assertIsNotNone(match)
        description = match.group(1).strip().strip('"')
        self.assertLessEqual(len(description), 180)
        self.assertLessEqual(len(text.splitlines()), 180)
        for reference in ROUTED_REFERENCES:
            self.assertIn(f"references/{reference}", text)
        for required in (
            "validate_requirement",
            "integration_required",
            "当前生产 provider 暴露 12 个 YPmcn 工具",
            "hook-behavior.md",
            "人工 gate",
            "`medium_risk_confirmed: true`",
            "`allow_need_confirm_with_risk: true`",
            "缺任一必填项不可进入候选搜索",
            "creator_candidate_pool_schema.csv",
            "confirm-ranking-after-supply-ready",
        ):
            self.assertIn(required, text)

    def test_main_skill_preflights_schema_without_pre_validate_confirmation(self):
        text = read(SKILL)
        for required in (
            "业务工具调用参数闸门",
            "运行时 `inputSchema`",
            "Brief 入口例外",
            "不得在调用 `validate_requirement` 前要求媒介确认",
            "直接调用 `validate_requirement`",
            "不得向用户索取或自行添加 `trace_id`、`idempotency_key`",
            "schema 冲突",
        ):
            self.assertIn(required, text)
        self.assertNotIn("pre-validate-requirement", text)

    def test_main_skill_uses_staged_confirmations_and_tool_cards(self):
        text = read(SKILL)
        joined = "\n".join(read(path) for path in source_files())
        for required in (
            "结构化 brief 确认",
            "MCN/野生比例确认",
            "表单字段确认",
            "企微角色权限",
            "核心算法在 MCP",
            "references/tools/<工具名>.md",
            "references/form-field-mapping.md",
        ):
            self.assertIn(required, text)
        for forbidden in (
            "`validate_requirement`、`search_creators`、`rank_mcns` 连续调用",
            "status=ready 时不暂停",
            "ready 后连续调用",
        ):
            self.assertNotIn(forbidden, joined)

    def test_tool_cards_exist_for_each_runtime_tool(self):
        tools_dir = REFERENCES / "tools"
        self.assertTrue(tools_dir.is_dir())
        actual = {path.name for path in tools_dir.glob("*.md")}
        self.assertEqual(EXPECTED_TOOL_CARDS, actual)
        for tool_card in EXPECTED_TOOL_CARDS:
            text = read(tools_dir / tool_card)
            for required in ("何时调用", "输入", "输出成功证据", "调用后必须停在哪里", "禁止"):
                self.assertIn(required, text)

    def test_tool_cheatsheet_matches_live_required_limits(self):
        text = read(REFERENCES / "mcp-tool-cheatsheet.md")
        for required in (
            "缺少 `trace_id` 或信封细项不由 hook 阻断",
            "`raw_messages_json`",
            "`budget_min_cents` / `budget_max_cents`",
            "`rebate_min_rate` / `rebate_max_rate`",
            "`id` | string（来自 `validate_requirement.data.id`）",
            "`id` | string（来自 `search_creators.data.id`）",
            "`prefillRowsBySupplier` / `prefill_rows_by_supplier`",
        ):
            self.assertIn(required, text)

    def test_mock_mcp_uses_chained_id_as_downstream_tool_input(self):
        text = read(ROOT / "mock-mcp.mjs")
        for tool_name in ("search_creators", "rank_mcns", "rank_creators", "manual_source_creators"):
            pattern = rf'\{{ name: "{tool_name}".*?inputSchema: .*?properties: \{{(.*?)\}} \}} \}}'
            match = re.search(pattern, text)
            self.assertIsNotNone(match, tool_name)
            properties = match.group(1)
            self.assertIn("id", properties)
            self.assertNotIn("demand_id", properties)
            self.assertNotIn("demand_version", properties)

    def test_rank_mcns_minimum_count_does_not_override_hard_filter_coverage(self):
        combined = "\n".join(
            read(path)
            for path in (
                REFERENCES / "tools" / "rank_mcns.md",
                REFERENCES / "mcp-tool-cheatsheet.md",
                REFERENCES / "mcp-tool-routing.md",
                REFERENCES / "ask-user-question-patterns.md",
            )
        )
        for required in (
            "硬筛后合格 MCN 少于 5 家",
            "`minimum_mcn_count=5` 自动失效",
            "不得为了凑满 5 家放宽硬筛条件",
            "预警媒介是否启动 `manual_source_creators` 手扒",
            "当前达人供需关系",
            "建议手扒比例",
        ):
            self.assertIn(required, combined)

    def test_hook_behavior_reference_covers_runtime_layers(self):
        text = read(REFERENCES / "hook-behavior.md")
        for required in (
            "before_tool_call",
            "after_tool_call",
            "tool_result_persist",
            "`validate_requirement` 请求",
            "不替代 MCP 业务校验",
            "allowed_actions",
            "workflow_state.pending_gate",
            "gate_id",
            "confirmation_type",
            "operator_id",
            "medium_risk_confirmed",
            "allow_need_confirm_with_risk",
            "INVALID_RESPONSE_CONTRACT",
            "原始 envelope",
            "缺少 `workflow_state` 或 `allowed_actions` 本身不是错误",
            "ranking_after_supply_ready_confirmed",
        ):
            self.assertIn(required, text)

    def test_project_distribution_hook_contract_is_documented(self):
        skill = read(SKILL)
        hook_behavior = read(REFERENCES / "hook-behavior.md")
        workflow = read(REFERENCES / "workflow-state-machine.md")
        readme = read(PACKAGE / "README.md")

        for required in (
            "`create_with_distributions`",
            "`deadline`",
            "`remindAt`",
            "`usageScope: \"project\"`",
            "唯一固定值",
            "`项目` 会被 hook 兼容归一",
            "不再触发 OpenClaw `requireApproval`",
            "用户确认前不得创建分发或发送通知",
            "确认对候选池进行达人精排",
        ):
            self.assertIn(required, skill + hook_behavior + readme)

        self.assertIn("当前不创建 Cron", hook_behavior + workflow + readme)
        self.assertIn("调用失败不进入等待锁", hook_behavior + workflow)
        self.assertIn("等机构回填和手扒结果回收到候选池", workflow)

    def test_requirement_intake_has_exact_input_boundary(self):
        text = read(REFERENCES / "requirement-intake.md")
        for key in (
            "platform",
            "submission_deadline_at",
            "raw_messages_json",
            "budget_min_cents",
            "budget_max_cents",
            "budget_raw",
            "rebate_min_rate",
            "rebate_max_rate",
            "rebate_raw",
            "quantity_total",
        ):
            self.assertIn(f"`{key}`", text)
        self.assertIn("creator_candidate_pool_schema.csv", text)
        self.assertIn("缺任一项不可继续", text)
        self.assertIn("额外需求必须参考", text)
        self.assertIn("字段不确定时先问", text)
        self.assertNotIn("用户「确认调用」前不得调用", text)
        self.assertNotIn("pre-validate-requirement", text)
        self.assertIn("构造 JSON 调 `validate_requirement`", text)
        self.assertIn("字段名与 CSV", text)

    def test_askuserquestion_is_the_only_confirmation_pattern(self):
        text = read(REFERENCES / "ask-user-question-patterns.md")
        joined = "\n".join(read(path) for path in source_files())
        for required in (
            "askuserquestion",
            "弹窗",
            "选项中文，短，互斥",
            "≤3 个互斥选项",
            "不要在 `validate_requirement` 调用前弹窗确认",
            "`requirement-draft`",
            "`confirm-structured-brief`",
            "`confirm-ranking-after-supply-ready`",
        ):
            self.assertIn(required, text)
        for forbidden in (
            "不得使用 `question()` 工具发起结构化提问",
            "所有 Agent 层暂停点统一使用文本表格",
            "每次停顿 = 一次文本表格输出",
            "选项数量不限",
            "pre-validate-requirement",
            "首次业务调用必须等用户确认",
        ):
            self.assertNotIn(forbidden, joined)

    def test_tool_routing_exposes_eleven_runtime_tools(self):
        text = read(REFERENCES / "mcp-tool-routing.md")
        table_tools = set(re.findall(r"^\| `([a-z_]+)` \|", text, re.M))
        self.assertEqual(EXPECTED_TOOLS, table_tools)
        for required in (
            "当前生产 12 个 YPmcn 工具",
            "create_with_distributions",
            "取代旧 `create_mcn_inquiries`",
            "运行时 schema",
            "record_client_feedback.data.next_action",
            "authorized_relaxations",
            "get_workflow_state",
            "medium_risk_confirmed",
            "allow_need_confirm_with_risk",
            "当前 schema 没有 `idempotency_key`",
        ):
            self.assertIn(required, text)
        self.assertIn("当前没有 `get_workflow_state`", text)

    def test_requirement_parsing_matches_customer_demands_boundary(self):
        text = read(REFERENCES / "requirement-parsing.md")
        for required in (
            "`platform`",
            "`quantity_total`",
            "`submission_deadline_at`",
            "`raw_messages_json`",
            "`budget_min_cents`",
            "`budget_max_cents`",
            "`rebate_min_rate`",
            "`rebate_max_rate`",
            "预算/单价和返点都必须区间化",
            "creator_candidate_pool_schema.csv",
            "用户未确认额外字段映射前，不进入 `search_creators`",
        ):
            self.assertIn(required, text)

    def test_database_table_contract_uses_legacy_names_and_split_creator_sources(self):
        joined = "\n".join(read(path) for path in source_files())
        with SCHEMA.open("r", encoding="utf-8-sig", newline="") as handle:
            schema_fields = {row["字段"] for row in csv.DictReader(handle) if row["字段"]}

        for field in (
            "platform",
            "raw_messages_json",
            "budget_min_cents",
            "budget_max_cents",
            "rebate_min_rate",
            "rebate_max_rate",
            "quantity_total",
            "status",
        ):
            self.assertIn(field, schema_fields)

        for required in (
            "需求主表固定为 `customer_demands`",
            "`validate_requirement` 写入 `customer_demands`",
            "字段以 `references/creator_candidate_pool_schema.csv` 的 `字段` 列为准",
            "达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`",
            "字段从需求主表继承",
            "`creator_candidate_pool`",
        ):
            self.assertIn(required, joined)

        for forbidden_table in (
            "`requirements`",
            "`creators`",
            "`candidate_pools`",
            "`creator_accounts`",
        ):
            self.assertNotIn(forbidden_table, joined)

    def test_state_machine_preserves_recovery_and_write_safety(self):
        text = read(REFERENCES / "workflow-state-machine.md")
        for field in (
            "phase",
            "requirement_id",
            "candidate_pool_id",
            "mcn_plan_id",
            "run_id",
            "inquiry_ids",
            "last_tool",
            "last_trace_id",
            "last_error",
        ):
            self.assertIn(f'"{field}"', text)
        for required in (
            "数据库事实",
            "workflow_state",
            "allowed_actions",
            "get_workflow_state",
            "当前请求 schema 没有幂等键，不得自动重试",
            "medium_risk_confirmed=true",
            "allow_need_confirm_with_risk=true",
            "get_recommendation_run_detail",
            "不重复写、不模拟成功",
            "confirm-ranking-after-supply-ready",
        ):
            self.assertIn(required, text)

    def test_frontend_response_is_short_and_private(self):
        text = read(REFERENCES / "frontend-response.md")
        self.assertIn("结论先行", text)
        self.assertIn("选项 ≤3", text)
        self.assertIn("元/万元", text)
        self.assertIn("百分比", text)
        self.assertIn("只转述 MCP 已确认字段", text)
        self.assertIn("失败只说当前步骤未完成", text)
        for private in (
            "requirement_parsed",
            "raw_messages",
            "排序向量",
            "数据库 ID",
        ):
            self.assertIn(private, text)

    def test_validation_playbook_defines_both_layers(self):
        text = read(REFERENCES / "validation-playbook.md")
        for required in (
            "tools/list",
            "12 个",
            "mock",
            "真实 MCP",
            "integration_required",
            "medium_risk_confirmed",
            "allow_need_confirm_with_risk",
            "缺少 `trace_id`",
            "Brief 入口不等待用户确认",
            "不强制添加 `trace_id`、`idempotency_key`",
        ):
            self.assertIn(required, text)

    def test_all_248_csv_rows_map_to_raw_validate_requirement_payloads(self):
        with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(["content"], list(rows[0]))
        self.assertEqual(248, len(rows))
        self.assertTrue(all(row["content"] for row in rows))

        calls = []

        def mock_validate_requirement(payload):
            calls.append(payload)
            return {
                "success": True,
                "data": {
                    "demand_id": f"demand-mock-{len(calls):03d}",
                    "demand_version": 1,
                    "status": "draft",
                    "blocking_fields": ["quantity_total"],
                },
                "error": None,
                "trace_id": f"trace-response-{len(calls):03d}",
            }

        for row_idx, row in enumerate(rows, start=1):
            payload = {
                "raw_messages": [
                    {"role": "client", "content": row["content"], "sent_at": None}
                ],
            }
            envelope = mock_validate_requirement(payload)
            self.assertIn("raw_messages", set(payload))
            self.assertEqual(row["content"], payload["raw_messages"][0]["content"])
            self.assertIsNone(payload["raw_messages"][0]["sent_at"])
            self.assertTrue(envelope["success"])
            self.assertIsNone(envelope["error"])
            self.assertEqual("draft", envelope["data"]["status"])
            self.assertIsNotNone(envelope["data"]["demand_id"])
            self.assertIsNotNone(envelope["data"]["demand_version"])
            self.assertTrue(envelope["trace_id"].startswith("trace-response-"))
            self.assertNotIn("workflow_state", envelope)
            self.assertNotIn("allowed_actions", envelope)
            self.assertNotIn("next_action", envelope)
            self.assertNotIn("idempotency_key", envelope)
        self.assertEqual(248, len(calls))

    def test_thirty_goldens_cover_ready_draft_and_edge_cases(self):
        cases = json.loads(read(GOLDENS_PATH))
        self.assertEqual(30, len(cases))
        self.assertEqual(30, len({case["row_number"] for case in cases}))
        self.assertEqual({"ready", "draft"}, {case["expected_status"] for case in cases})
        self.assertTrue(any(case.get("unsupported_platforms") for case in cases))
        self.assertTrue(any(case.get("relative_time_without_sent_at") for case in cases))
        self.assertTrue(any(case.get("expected_platforms") == ["xhs", "dy"] for case in cases))
        self.assertTrue(any("platform" in case["blocking_fields"] for case in cases))
        self.assertTrue(any("submission_deadline_at" in case["blocking_fields"] for case in cases))

        with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        for case in cases:
            self.assertEqual(f"row-{case['row_number']:03d}", case["id"])
            self.assertNotIn("content", case)
            self.assertLessEqual(case["row_number"], len(rows))
            self.assertTrue(set(case["blocking_fields"]).issubset(BLOCKING_FIELDS))
            if case["expected_status"] == "ready":
                self.assertEqual([], case["blocking_fields"])
            else:
                self.assertTrue(case["blocking_fields"])
            self.assertTrue(set(case["expected_platforms"]).issubset({"xhs", "dy"}))

    def test_requirement_regressions_cover_parsing_and_versioning(self):
        cases = json.loads(read(REGRESSIONS_PATH))
        self.assertEqual(
            {
                "budget-only",
                "quantity-only",
                "budget-and-quantity",
                "agent-correction-same-version",
                "human-budget-change-new-version",
                "human-repeat-no-version",
                "human-ack-no-version",
                "stale-version-conflict",
            },
            {case["id"] for case in cases},
        )

        by_id = {case["id"]: case for case in cases}
        self.assertEqual(
            {"budget_max_cents": 300000, "quantity_total": None},
            by_id["budget-only"]["expected_fields"],
        )
        self.assertEqual(
            {"budget_max_cents": None, "quantity_total": 3000},
            by_id["quantity-only"]["expected_fields"],
        )
        self.assertEqual(
            {"budget_max_cents": 300000, "quantity_total": 10},
            by_id["budget-and-quantity"]["expected_fields"],
        )

        correction = by_id["agent-correction-same-version"]
        self.assertEqual(1, correction["existing_demand_version"])
        self.assertEqual(1, correction["expected_demand_version"])
        self.assertTrue(correction["expected_run_invalidated"])
        self.assertEqual("agent_correction", correction["expected_version_reason"])

        human_change = by_id["human-budget-change-new-version"]
        self.assertEqual(1, human_change["existing_demand_version"])
        self.assertEqual(2, human_change["expected_demand_version"])
        self.assertEqual("human_requirement_change", human_change["expected_version_reason"])

        for case_id in ("human-repeat-no-version", "human-ack-no-version"):
            case = by_id[case_id]
            self.assertEqual(case["existing_demand_version"], case["expected_demand_version"])
            self.assertEqual("no_material_change", case["expected_version_reason"])

        conflict = by_id["stale-version-conflict"]
        self.assertEqual(1, conflict["existing_demand_version"])
        self.assertEqual(2, conflict["server_demand_version"])
        self.assertEqual("VERSION_CONFLICT", conflict["expected_error_code"])
        self.assertFalse(conflict["expected_write"])

        for case in cases:
            self.assertTrue(case["raw_messages"])
            self.assertTrue(
                all(message["role"] in {"client", "media", "agent", "system"} for message in case["raw_messages"])
            )

    def test_package_has_no_machine_paths_or_python_pip_instructions(self):
        joined = "\n".join(read(path) for path in source_files())
        self.assertNotIn("/Users/", joined)
        self.assertNotIn("pip install", joined)
        self.assertFalse((PACKAGE / ".workbuddy-plugin").exists())


if __name__ == "__main__":
    unittest.main()
