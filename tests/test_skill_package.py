import csv
import hashlib
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
TOOLS_DIR = REFERENCES / "tools"
CSV_SCHEMA = REFERENCES / "reference_schema.csv"

EXPECTED_REFERENCE_FILES = {
    "ask-user-question-patterns.md",
    "form-field-mapping.md",
    "frontend-response.md",
    "hook-behavior.md",
    "mcp-tool-cheatsheet.md",
    "contract-gate.md",
    "phase-tool-matrix.md",
    "requirement-intake.md",
    "requirement-parsing.md",
    "validation-playbook.md",
}
EXPECTED_CSV_SHA256 = "c822ec617d53a4da423dbbcbef2b607f971c16ccc0ec7481874518d85f76fb97"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def section(text: str, heading: str) -> str:
    match = re.search(
        rf"^## {re.escape(heading)}\s*$\n(.*?)(?=^## |\Z)",
        text,
        re.MULTILINE | re.DOTALL,
    )
    return match.group(1) if match else ""


class SkillPackageContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = json.loads(read(PROFILE_PATH))
        cls.workflow = json.loads(read(WORKFLOW_PATH))
        cls.required_tools = cls.profile["requiredTools"]
        cls.all_tools = set(cls.profile["tools"])

    def test_package_contains_runtime_contract_and_operator_entrypoints(self):
        required = [
            ROOT / "AGENTS.md",
            ROOT / "README.md",
            PACKAGE / "README.md",
            PACKAGE / "openclaw.plugin.json",
            PACKAGE / "src" / "index.ts",
            PACKAGE / "hooks" / "pre_tool_guard.py",
            PACKAGE / "hooks" / "post_tool_update.py",
            PACKAGE / "hooks" / "session_cleanup.py",
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
        self.assertLessEqual(len(text.splitlines()), 180)
        for name in EXPECTED_REFERENCE_FILES:
            self.assertIn(f"references/{name}", text)
        for required in (
            "integration_required",
            "sync → ingest → sync",
        ):
            self.assertIn(required, text)

    def test_every_declared_tool_has_one_structured_card(self):
        actual = {path.stem for path in TOOLS_DIR.glob("*.md")}
        documented_tools = self.all_tools - {"search_creator_tag_vectors"}
        self.assertEqual(documented_tools, actual)
        for name in documented_tools:
            text = read(TOOLS_DIR / f"{name}.md")
            self.assertTrue(text.startswith(f"# {name}\n"), name)
            for heading in ("何时调用", "输入", "输出成功证据", "调用后必须停在哪里", "错误与停止条件"):
                self.assertTrue(section(text, heading).strip(), f"{name}: {heading}")

    def test_tool_card_inputs_and_success_evidence_derive_from_profile(self):
        for name in self.all_tools - {"search_creator_tag_vectors"}:
            contract = self.profile["tools"][name]
            text = read(TOOLS_DIR / f"{name}.md")
            input_text = section(text, "输入")
            success_text = section(text, "输出成功证据")
            error_text = section(text, "错误与停止条件")
            for key in contract["required"]:
                self.assertIn(f"`{key}`", input_text, f"{name}: required {key}")
            for evidence in contract["successEvidence"]:
                self.assertIn(evidence, success_text, f"{name}: evidence {evidence}")
            for forbidden in contract["forbidden"]:
                self.assertIn(f"`{forbidden}`", error_text, f"{name}: forbidden {forbidden}")

    def test_documented_id_routing_matches_current_endpoint(self):
        routing = read(REFERENCES / "phase-tool-matrix.md")
        for mapping in (
            "validate_requirement(payload)",
            "search_creators(id)",
            "rank_mcns(id, platform)",
            "rank_creators(requirement_id, limit)",
            "证据不足 → `integration_required`",
        ):
            self.assertIn(mapping, routing)
        for obsolete in (
            "search_creators.data.id → candidate_pool_id",
            "rank_mcns.data.id → mcn_recommendation_id",
        ):
            self.assertNotIn(obsolete, routing)

    def test_workflow_reference_contains_exact_machine_phases_and_recovery_order(self):
        text = read(REFERENCES / "phase-tool-matrix.md")
        for phase in self.workflow["phases"]:
            self.assertIn(f"`{phase}`", text)
        for required in (
            "distribution_sync_pending",
            "实际 success",
            "manual",
            "scheduled",
            "ctx.trigger=cron",
            "recovery_sync_pending",
            "最终 sync",
            "不得盲目重试",
        ):
            self.assertIn(required, text)

    def test_send_and_recovery_docs_are_fail_closed(self):
        joined = "\n".join(read(path) for path in [SKILL, *REFERENCES.glob("*.md"), *TOOLS_DIR.glob("*.md")])
        for required in (
            "用户确认",
            "写结果未知",
            "普通消息不解除等待",
            "只有实际 MCP 返回算证据",
        ):
            self.assertIn(required, joined)
        for pattern in (
            r"preview_only\s*[:=]\s*true",
            r"先\s*preview",
            r"waiting_mcn_return",
            r"candidate_pool_enriched",
            r"回收到候选池",
            r"解除项目分发等待锁",
            r"当前不创建\s*Cron",
        ):
            self.assertIsNone(re.search(pattern, joined, re.IGNORECASE), pattern)

    def test_provider_contract_mismatch_is_a_hard_integration_error(self):
        joined = "\n".join(read(path) for path in [SKILL, REFERENCES / "contract-gate.md", REFERENCES / "phase-tool-matrix.md"])
        for required in (
            "当前 Endpoint schema 优先于旧 mvp-v2",
            "select_inquiry_form_fields",
            "create_with_distributions",
            "sync_mcn_inquiry_status",
            "integration_required",
        ):
            self.assertIn(required, joined)
        self.assertNotIn("缺 `select_inquiry_form_fields`", joined)

    def test_reference_file_inventory_is_exact(self):
        actual = {path.name for path in REFERENCES.glob("*.md")}
        self.assertEqual(EXPECTED_REFERENCE_FILES, actual)

    def test_requirement_parsing_routes_creator_price_to_official_price_tiers(self):
        parsing = read(REFERENCES / "requirement-parsing.md")
        intake = read(REFERENCES / "requirement-intake.md")
        tool_card = read(TOOLS_DIR / "validate_requirement.md")
        joined = "\n".join((parsing, intake, tool_card))
        for field in (
            "kolOfficialPriceL1",
            "kolOfficialPriceL2",
            "kolOfficialPriceL3",
        ):
            self.assertIn(field, parsing)
            self.assertIn(field, tool_card)
        for required in (
            "单人预算",
            "项目总预算",
            "小红书",
            "抖音",
            "1–20 秒",
            "21–60 秒",
            "60 秒以上",
            "元转分",
            "不得写入 `budget*`",
        ):
            self.assertIn(required, joined)
        for obsolete in (
            "`quantity_total`",
            "`submission_deadline_at`",
            "`content_requirements`",
            "`category_requirements`",
        ):
            self.assertNotIn(obsolete, parsing)

    def test_requirement_intake_requires_scored_preview_before_persistence(self):
        skill = read(SKILL)
        parsing = read(REFERENCES / "requirement-parsing.md")
        intake = read(REFERENCES / "requirement-intake.md")
        tool_card = read(TOOLS_DIR / "validate_requirement.md")
        routing = read(REFERENCES / "phase-tool-matrix.md")
        joined = "\n".join((skill, parsing, intake, tool_card, routing))
        for required in (
            "字段预览",
            "原文保留",
            "歧义",
            "解析评分",
            "score > 80",
            "score === 80",
            "各 5 分",
            "每个杜撰或擅自推断值扣 10 分",
            "不得先调用再补展示",
            "原子需求",
            "quantityTotal=2",
            "rebateMinRate=0.3",
            "价格 4w",
            "不主动提交 `status=ready`",
        ):
            self.assertIn(required, joined)

    def test_csv_authority_keeps_supplied_line_count_fields_and_hash(self):
        raw = CSV_SCHEMA.read_bytes()
        self.assertEqual(EXPECTED_CSV_SHA256, hashlib.sha256(raw).hexdigest())
        with CSV_SCHEMA.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(323, len(rows))
        fields = [row["Field"] for row in rows]
        self.assertEqual(len(fields), len(set(fields)))
        for field in (
            "id",
            "demandId",
            "projectName",
            "brandName",
            "status",
            "platform",
            "kwUid",
        ):
            self.assertIn(field, fields)

    def test_creator_search_field_authority_matches_current_database(self):
        texts = [
            read(SKILL),
            read(TOOLS_DIR / "search_creators.md"),
            read(TOOLS_DIR / "get_creator_detail.md"),
            read(TOOLS_DIR / "ingest_mcn_submissions.md"),
            read(TOOLS_DIR / "manual_source_creators.md"),
        ]
        joined = "\n".join(texts)
        for required in (
            "kolOfficialPriceL1/L2/L3",
            "达人—机构关系",
            "不是机构实际返点",
            "creator_id",
            "supplier_binding_id",
        ):
            self.assertIn(required, joined)

    def test_hook_reference_matches_registered_safe_event_surface(self):
        text = read(REFERENCES / "hook-behavior.md")
        for event in (
            "PreToolUse",
            "PostToolUse",
            "Stop",
        ):
            self.assertIn(f"`{event}`", text)
        for required in ("TTL", "会话投影", "不记录完整 payload"):
            self.assertIn(required, text)

    def test_hook_docs_map_public_projection_to_machine_phases(self):
        text = read(REFERENCES / "hook-behavior.md")
        for required in (
            "session_id",
            "未知输出不推进",
            "description 与最终 `columns`",
            "旧 `mcn_recommendation_id`",
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
            "统一验证覆盖 204 项测试",
            "人类文档同步、自动提交与精简度：5 项",
            "根 workspace 安装图：1 项",
            "provider checker：8 项；Python Hook：24 项",
            "Skill、工具卡和文档一致性：16 项",
        ):
            self.assertIn(required, text)
        self.assertNotIn("统一验证覆盖 207 项测试", text)

    def test_agent_instructions_keep_specs_authoritative_and_production_separate(self):
        text = read(ROOT / "AGENTS.md")
        for required in (
            "spec/mcp.json",
            "spec/workflow.json",
            "npm run verify",
            "npm run verify:provider",
            "uv",
            "reference-mcp",
            "生产 provider",
        ):
            self.assertIn(required, text)

    def test_docs_do_not_embed_machine_paths_or_pip_install(self):
        paths = [ROOT / "AGENTS.md", ROOT / "CLAUDE.md", ROOT / "README.md", PACKAGE / "README.md", SKILL]
        paths.extend(REFERENCES.glob("*.md"))
        paths.extend(TOOLS_DIR.glob("*.md"))
        joined = "\n".join(read(path) for path in paths if path.exists())
        self.assertNotIn("/Users/", joined)
        self.assertNotIn("pip install", joined)


if __name__ == "__main__":
    unittest.main()
