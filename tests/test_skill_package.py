import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "YPmcn"
PROFILE_PATH = ROOT / "spec" / "mcp.json"
WORKFLOW_PATH = ROOT / "spec" / "workflow.json"
SKILL = PACKAGE / "skills" / "media-assistant" / "SKILL.md"
REFERENCES = SKILL.parent / "references"
SCHEMA = REFERENCES / "reference_schema.json"
REQUIREMENT_CASES = ROOT / "tests" / "goldens" / "requirement_cases.json"
REQUIREMENT_REGRESSIONS = ROOT / "tests" / "goldens" / "requirement_regressions.json"

EXPECTED_REFERENCE_FILES = {
    "execution-gates.md",
    "form-field-mapping.md",
    "frontend-response.md",
    "requirement-intake.md",
}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def count_han(text: str) -> int:
    ranges = (
        (0x3400, 0x4DBF),
        (0x4E00, 0x9FFF),
        (0xF900, 0xFAFF),
        (0x20000, 0x2EBEF),
        (0x30000, 0x323AF),
    )
    return sum(any(start <= ord(char) <= end for start, end in ranges) for char in text)


class SkillPackageContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = json.loads(read(PROFILE_PATH))
        cls.workflow = json.loads(read(WORKFLOW_PATH))
        cls.required_tools = cls.profile["requiredTools"]
        cls.all_tools = set(cls.profile["tools"])

    def test_source_tree_contains_current_runtime_and_legacy_regression_entrypoints(self):
        required = [
            ROOT / "README.md",
            PACKAGE / "README.md",
            PACKAGE / "openclaw.plugin.json",
            PACKAGE / "src" / "index.ts",
            PACKAGE / "src" / "runtime-hooks.ts",
            PROFILE_PATH,
            WORKFLOW_PATH,
            SKILL,
        ]
        for path in required:
            self.assertTrue(path.is_file(), path)

    def test_skill_is_a_small_router_to_all_operator_references(self):
        text = read(SKILL)
        frontmatter = re.search(r"^---\n.*?^description:\s*(.+?)\n---", text, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(frontmatter)
        self.assertLessEqual(len(frontmatter.group(1).strip().strip('"')), 180)
        self.assertLessEqual(len(text.splitlines()), 50)
        for name in EXPECTED_REFERENCE_FILES:
            self.assertIn(f"references/{name}", text)
        for required in (
            "integration_required",
            "execution-gates.md",
        ):
            self.assertIn(required, text)
        for path in SKILL.parent.rglob("*"):
            if path.is_file():
                self.assertLessEqual(len(path.read_bytes().splitlines()), 50, path)

    def test_skill_markdown_stays_within_three_thousand_han_characters(self):
        markdown = [SKILL, *sorted(REFERENCES.rglob("*.md"))]
        self.assertEqual(1 + len(EXPECTED_REFERENCE_FILES), len(markdown))
        self.assertLessEqual(sum(count_han(read(path)) for path in markdown), 3000)

    def test_skill_repairs_requirement_arguments_but_stops_other_hook_failures(self):
        text = "\n".join((
            read(SKILL),
            read(REFERENCES / "requirement-intake.md"),
            read(REFERENCES / "execution-gates.md"),
        ))
        for required in (
            "参数校验失败",
            "同一轮持续重新调用直到成功",
            "保持原始需求语义",
            "只修报错字段、序列化、映射或审计计数",
            "除上述 `validate_requirement` 参数自修复外，Hook 任意阻断后立即停止",
            '`details.status="blocked"`',
            "不改写 payload、ID 或已映射字段",
            '`details.deniedReason="plugin-before-tool-call"`',
            "未到 MCP/Provider",
            "只有实际远程 response/trace 才能归因 MCP/Provider",
            "用户要求失败即停时绝不重试",
        ):
            self.assertIn(required, text)

    def test_skill_requires_provenance_for_detail_and_write_ids(self):
        text = read(SKILL)
        for required in (
            "核对 ID 血缘",
            "实际成功响应或已验证状态返回的 ID",
            "不得猜测、串用或用虚构 ID 探测详情",
            "integration_required",
        ):
            self.assertIn(required, text)

    def test_documented_id_routing_matches_current_endpoint(self):
        routing = read(REFERENCES / "execution-gates.md")
        for mapping in (
            "需求身份来自 `validate_requirement`",
            "`demand_id+demand_version` 只用于状态版本",
            "`project_id+mcn_id+requirement_id` 绑定 distribution",
            "`inquiry_id` 绑定回收",
            "`run_id` 只来自精排或验证状态",
        ):
            self.assertIn(mapping, routing)
        for obsolete in (
            "search_creators.data.id → candidate_pool_id",
            "rank_mcns.data.id → mcn_recommendation_id",
        ):
            self.assertNotIn(obsolete, routing)

    def test_workflow_reference_routes_to_machine_contract_and_recovery_order(self):
        text = read(REFERENCES / "execution-gates.md")
        for required in (
            "spec/manifest.json",
            "spec/mcp.json",
            "spec/workflow.json",
            "workflow_state",
            "allowed_actions",
            "sync → ingest_mcn_submissions → sync",
            "禁止盲重试",
        ):
            self.assertIn(required, text)
        self.assertEqual(len(self.workflow["phases"]), len(set(self.workflow["phases"])))

    def test_send_and_recovery_docs_are_fail_closed(self):
        joined = "\n".join(read(path) for path in [SKILL, *REFERENCES.glob("*.md")])
        for required in (
            "Native Ask",
            "写结果未知",
            "只有实际 MCP 返回算成功证据",
            "真实外发",
            "全部回收",
        ):
            self.assertIn(required, joined)
        for pattern in (
            r"preview_only\s*[:=]\s*true",
            r"先\s*preview",
            r"回收到候选池",
            r"解除项目分发等待锁",
            r"当前不创建\s*Cron",
        ):
            self.assertIsNone(re.search(pattern, joined, re.IGNORECASE), pattern)
    def test_provider_contract_mismatch_is_a_hard_integration_error(self):
        joined = "\n".join(read(path) for path in [SKILL, REFERENCES / "execution-gates.md"])
        for required in (
            "Endpoint schema 优先",
            "select_inquiry_form_fields",
            "create_with_distributions",
            "integration_required",
        ):
            self.assertIn(required, joined)
        self.assertNotIn("缺 `select_inquiry_form_fields`", joined)

    def test_reference_file_inventory_is_exact(self):
        actual = {path.name for path in REFERENCES.glob("*.md")}
        self.assertEqual(EXPECTED_REFERENCE_FILES, actual)
        self.assertFalse(any((REFERENCES / "tools").glob("*.md")))

    def test_requirement_parsing_routes_creator_price_to_official_price_tiers(self):
        intake = read(REFERENCES / "requirement-intake.md")
        schema_fields = {row["Field"] for row in json.loads(read(SCHEMA))["columns"]}
        for field in (
            "kolOfficialPriceL1",
            "kolOfficialPriceL2",
            "kolOfficialPriceL3",
        ):
            self.assertIn(field, intake)
        for required in (
            "单达人预算",
            "项目总预算",
            "小红书",
            "抖音",
            "1–20",
            "21–60",
            "60 秒以上",
            '"[min,max]"',
            "不得杜撰字段",
        ):
            self.assertIn(required, intake)
        self.assertNotIn("businessIndustry", schema_fields)
        for obsolete in (
            "`quantity_total`",
            "`submission_deadline_at`",
            "`content_requirements`",
            "`category_requirements`",
        ):
            self.assertNotIn(obsolete, intake)

    def test_requirement_intake_uses_three_state_gate_before_persistence(self):
        skill = read(SKILL)
        intake = read(REFERENCES / "requirement-intake.md")
        joined = "\n".join((skill, intake))
        for required in (
            "原文",
            "missing_required",
            "semantic_ambiguity",
            "`ready`",
            "业务可选",
            "__UNRESOLVED__",
            "ypmcn-brief-v1",
            "currentLocalDateTime",
            "完整 Brief 拆成原子需求",
            "缺失、歧义清单",
            "30%+→[0.3,1]",
            '`{"payload": {..., "status": "ready"}}`',
        ):
            self.assertIn(required, joined)
        self.assertNotIn("score > 80", joined)
        self.assertNotIn("score === 80", joined)
        self.assertNotIn("不存在、为空或无法生成", joined)

    def test_requirement_goldens_use_current_range_boundary(self):
        cases = json.loads(read(REQUIREMENT_CASES))
        regressions = json.loads(read(REQUIREMENT_REGRESSIONS))
        canonical_range = re.compile(r"^\[(?:0|[1-9]\d*)(?:\.\d+)?,(?:0|[1-9]\d*)(?:\.\d+)?\]$")

        self.assertTrue(cases)
        self.assertTrue(regressions)
        for case in cases:
            for field, value in case.get("expected_range_fields", {}).items():
                self.assertIn(field, read(SCHEMA))
                self.assertIsInstance(value, str)
                self.assertRegex(value, canonical_range)
                lower, upper = json.loads(value)
                self.assertLessEqual(lower, upper)
            for field in case.get("forbidden_fields", []):
                self.assertNotIn(field, read(SCHEMA))

        by_id = {item["id"]: item for item in regressions}
        self.assertEqual("allow", by_id["canonical-range-string"]["expected_guard"])
        self.assertEqual("[0,0.5]", by_id["canonical-range-string"]["payload_fragment"]["femaleRate"])
        rebate_full_brief = by_id["rebate-preserved-regression-full-brief"]
        self.assertEqual("semantic_ambiguity", rebate_full_brief["expected_gate"])
        self.assertEqual({
            "atomCount": 6,
            "mappedCount": 5,
            "preservedCount": 0,
            "unresolvedCount": 1,
        }, rebate_full_brief["expected_preview_summary"])
        self.assertEqual({
            "mappedCount": 6,
            "unresolvedCount": 0,
        }, rebate_full_brief["forbidden_preview_summary"])
        self.assertEqual(
            rebate_full_brief["expected_preview_summary"]["atomCount"],
            rebate_full_brief["expected_preview_summary"]["mappedCount"]
            + rebate_full_brief["expected_preview_summary"]["preservedCount"]
            + rebate_full_brief["expected_preview_summary"]["unresolvedCount"],
        )
        self.assertGreater(rebate_full_brief["expected_preview_summary"]["unresolvedCount"], 0)
        self.assertEqual(0, rebate_full_brief["expected_tool_calls_before_confirmation"])
        self.assertEqual(5, rebate_full_brief["expected_payload_fragment"]["quantityTotal"])
        self.assertIsInstance(rebate_full_brief["expected_payload_fragment"]["quantityTotal"], int)
        self.assertEqual("[5,5]", rebate_full_brief["forbidden_payload_fragment"]["quantityTotal"])
        self.assertEqual("[0.3,1]", rebate_full_brief["expected_payload_fragment"]["rebate"])
        self.assertEqual({
            "sourceText": "返点30%以上",
            "disposition": "mapped",
            "targetField": "rebate",
        }, rebate_full_brief["expected_audit_atom"])
        self.assertEqual("preserved", rebate_full_brief["forbidden_rebate_disposition"])
        ambiguous_account_type = by_id["ambiguous-account-type-taxonomy"]
        self.assertEqual("semantic_ambiguity", ambiguous_account_type["expected_gate"])
        self.assertEqual(["contentTag", "pgyBloggerTypeLabel"], ambiguous_account_type["forbidden_inferred_fields"])
        self.assertIn("账号类型：母婴类、亲子相关", ambiguous_account_type["brief_fragment"])
        for regression_id, wording in (
            ("rebate-lower-bound-plus", "返点30%+"),
            ("rebate-lower-bound-chinese", "返点30%以上"),
        ):
            self.assertEqual("allow", by_id[regression_id]["expected_guard"])
            self.assertEqual(wording, by_id[regression_id]["brief_fragment"])
            self.assertEqual("[0.3,1]", by_id[regression_id]["payload_fragment"]["rebate"])
        for regression_id, expected_range in (
            ("rebate-exact-percentage", "[0.3,0.3]"),
            ("rebate-bounded-percentage", "[0.2,0.3]"),
        ):
            self.assertEqual("allow", by_id[regression_id]["expected_guard"])
            self.assertEqual(expected_range, by_id[regression_id]["payload_fragment"]["rebate"])
        self.assertTrue(all(
            item["expected_guard"] == "block"
            for item in regressions
            if item["id"] not in {
                "canonical-range-string",
                "rebate-lower-bound-plus",
                "rebate-lower-bound-chinese",
                "rebate-exact-percentage",
                "rebate-bounded-percentage",
            }
        ))

        serialized = json.dumps([cases, regressions], ensure_ascii=False)
        for obsolete in ("quantity_total", "submission_deadline_at", "budget_min_cents", "budget_max_cents"):
            self.assertNotIn(obsolete, serialized)

    def test_compact_schema_keeps_all_verified_columns_and_shapes(self):
        schema = json.loads(read(SCHEMA))
        self.assertEqual(1, schema["schemaVersion"])
        self.assertEqual("ypmcn.customer_demands", schema["table"])
        self.assertEqual("2026-07-18", schema["verifiedAt"])
        rows = schema["columns"]
        self.assertEqual(61, len(rows))
        fields = [row["Field"] for row in rows]
        self.assertEqual(len(fields), len(set(fields)))
        for field in (
            "id", "demandId", "projectName", "brandName", "status",
            "platform", "rawMessagesJson", "followercount",
        ):
            self.assertIn(field, fields)
        by_field = {row["Field"]: row for row in rows}
        for field, row in by_field.items():
            self.assertEqual({
                "Field", "Type", "InputShape", "Example", "FilterMode",
                "Null", "Key", "Default", "Extra", "Comment",
            }, set(row), field)
            shape = row["InputShape"].removesuffix(" (Provider-managed)")
            example = row["Example"]
            self.assertTrue(example, f"{field}: missing example")
            if shape == "range-string [min,max]":
                bounds = json.loads(example)
                self.assertEqual(2, len(bounds), field)
                self.assertTrue(all(isinstance(value, (int, float)) for value in bounds), field)
                self.assertLessEqual(bounds[0], bounds[1], field)
                self.assertEqual(example, json.dumps(bounds, separators=(",", ":")), field)
            elif shape == "json-array":
                self.assertIsInstance(json.loads(example), list, field)
            elif shape == "json-object":
                self.assertIsInstance(json.loads(example), dict, field)
            elif shape in {"integer", "boolean-integer 0|1"}:
                value = int(example)
                if shape == "boolean-integer 0|1":
                    self.assertIn(value, (0, 1), field)
            elif shape == "number":
                self.assertIsInstance(float(example), float, field)
            elif shape == "datetime-string YYYY-MM-DD HH:mm:ss":
                self.assertRegex(example, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", field)
        self.assertEqual("YES", by_field["kolOfficialPriceL1"]["Null"])
        self.assertEqual("varchar(255)", by_field["kolOfficialPriceL1"]["Type"])
        self.assertIn("[min,max]", by_field["kolOfficialPriceL1"]["Comment"])
        self.assertIn("至少一项为Brief业务必填", by_field["kolOfficialPriceL1"]["Comment"])
        self.assertEqual("NO", by_field["rebate"]["Null"])
        self.assertEqual("range-string [min,max]", by_field["rebate"]["InputShape"])
        self.assertEqual([0.05, 0.10], json.loads(by_field["rebate"]["Example"]))
        self.assertEqual("integer", by_field["quantityTotal"]["InputShape"])
        self.assertEqual(10, int(by_field["quantityTotal"]["Example"]))
        self.assertEqual("json-object", by_field["rawMessagesJson"]["InputShape"])
        self.assertIsInstance(json.loads(by_field["rawMessagesJson"]["Example"]), dict)
        self.assertEqual("text", by_field["contentTag"]["Type"])
        self.assertEqual("string", by_field["contentTag"]["InputShape"])
        self.assertEqual("美妆,护肤", by_field["contentTag"]["Example"])
        self.assertEqual("json-array", by_field["pgyBloggerTypeLabel"]["InputShape"])
        self.assertIsInstance(json.loads(by_field["pgyBloggerTypeLabel"]["Example"]), list)
        self.assertEqual("boolean-integer 0|1", by_field["hasOrganization"]["InputShape"])
        self.assertEqual("datetime-string YYYY-MM-DD HH:mm:ss", by_field["submissionDeadlineAt"]["InputShape"])
        self.assertEqual("[min,max]", by_field["followercount"]["FilterMode"])
        self.assertEqual("向量查询", by_field["pgyBloggerTypeLabel"]["FilterMode"])
        self.assertNotIn("budgetMinCents", by_field)
        self.assertNotIn("submissionDeadlineRaw", by_field)
        self.assertIn("ypmcn-brief-v1", by_field["rawMessagesJson"]["Comment"])

    def test_output_assets_fix_wecom_and_submission_shapes(self):
        assets = PACKAGE / "skills" / "media-assistant" / "assets"
        csv_header = (assets / "ypmcn_submission_template.csv").read_text(encoding="utf-8").strip()
        self.assertEqual(
            "排名,平台,达人昵称,达人ID,来源,机构名称,官方报价（元）,提报报价（元）,提报返点（%）,推荐得分,推荐理由,风险提示",
            csv_header,
        )
        wecom = (assets / "wecom_inquiry_template.txt").read_text(encoding="utf-8")
        for required in (
            "【{project_name}｜达人提报】",
            "平台：{{platform}}",
            "回填要求：{{content_requirement}}",
            "单达人预算：{{creator_budget_tier_and_amount}}",
            "提报截止：{deadline}",
            "回填字段：{{confirmed_column_names}}",
            "{form_link}",
        ):
            self.assertIn(required, wecom)

    def test_creator_search_field_authority_matches_current_database(self):
        texts = [
            read(SKILL),
            read(REFERENCES / "execution-gates.md"),
            read(REFERENCES / "requirement-intake.md"),
        ]
        joined = "\n".join(texts)
        for required in (
            "kolOfficialPriceL1/L2/L3",
            "需求返点不是机构实际返点",
            "creator_id",
            "supplier_binding_id",
        ):
            self.assertIn(required, joined)

    def test_hook_reference_matches_registered_safe_event_surface(self):
        text = read(REFERENCES / "execution-gates.md")
        for event in (
            "before_tool_call",
            "after_tool_call",
            "session_end",
        ):
            self.assertIn(f"`{event}`", text)
        for required in ("无会话依赖", "不记录完整 payload"):
            self.assertIn(required, text)

    def test_hook_docs_map_public_projection_to_machine_phases(self):
        text = read(REFERENCES / "execution-gates.md")
        for required in (
            "不推进数据库 phase",
            "workflow_state + allowed_actions",
            "写结果未知",
        ):
            self.assertIn(required, text)

    def test_root_readme_uses_current_unified_verification_commands(self):
        text = read(ROOT / "README.md")
        self.assertIn("npm run verify", text)
        self.assertIn("npm run verify:provider", text)
        self.assertNotIn("统一入口将在", text)
        self.assertNotIn("cd YPmcn && npm test", text)

    def test_readiness_report_matches_current_verification_inventory(self):
        text = read(ROOT / "docs" / "integration-readiness.md")
        for required in (
            "OpenClaw 插件、契约与 Native Node Hook",
            "provider checker",
            "Skill、按需引用和文档一致性",
            "旧 Python Hook 状态机已从当前验收门禁移除",
        ):
            self.assertIn(required, text)
        self.assertNotIn("统一验证覆盖 207 项测试", text)

    def test_docs_do_not_embed_machine_paths_or_pip_install(self):
        paths = [ROOT / "README.md", PACKAGE / "README.md", SKILL]
        paths.extend(REFERENCES.glob("*.md"))
        joined = "\n".join(read(path) for path in paths if path.exists())
        self.assertNotIn("/Users/", joined)
        self.assertNotIn("pip install", joined)


if __name__ == "__main__":
    unittest.main()
