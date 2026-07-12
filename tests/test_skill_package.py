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
CSV_SCHEMA = REFERENCES / "creator_candidate_pool_schema.csv"

EXPECTED_REFERENCE_FILES = {
    "ask-user-question-patterns.md",
    "form-field-mapping.md",
    "frontend-response.md",
    "hook-behavior.md",
    "mcp-tool-cheatsheet.md",
    "mcp-tool-routing.md",
    "requirement-intake.md",
    "requirement-parsing.md",
    "validation-playbook.md",
    "workflow-state-machine.md",
}
EXPECTED_CSV_SHA256 = "63261c8b9c727ed7992dba8ef474656b51c4dc9fff0d22df8533509a02071ed5"


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

    def test_package_contains_runtime_contract_and_operator_entrypoints(self):
        required = [
            ROOT / "AGENTS.md",
            ROOT / "README.md",
            PACKAGE / "README.md",
            PACKAGE / "openclaw.plugin.json",
            PACKAGE / "src" / "index.ts",
            PACKAGE / "src" / "hooks" / "guards.ts",
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
            "mvp-v2",
            "integration_required",
            "select_inquiry_form_fields",
            "sync_mcn_inquiry_status",
            "字段选择是发送前最后确认点",
            "普通消息不解除等待",
            "sync → ingest → sync",
        ):
            self.assertIn(required, text)

    def test_every_required_tool_has_one_structured_card(self):
        actual = {path.stem for path in TOOLS_DIR.glob("*.md")}
        self.assertEqual(set(self.required_tools), actual)
        for name in self.required_tools:
            text = read(TOOLS_DIR / f"{name}.md")
            self.assertTrue(text.startswith(f"# {name}\n"), name)
            for heading in ("何时调用", "输入", "输出成功证据", "调用后必须停在哪里", "错误与停止条件"):
                self.assertTrue(section(text, heading).strip(), f"{name}: {heading}")

    def test_tool_card_inputs_and_success_evidence_derive_from_profile(self):
        for name in self.required_tools:
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

    def test_documented_semantic_id_chain_matches_v2(self):
        routing = read(REFERENCES / "mcp-tool-routing.md")
        for mapping in (
            "validate_requirement.data.id → requirement_id",
            "search_creators.data.id → candidate_pool_id",
            "rank_mcns.data.id → mcn_recommendation_id",
            "rank_creators.data.run_id → run_id",
        ):
            self.assertIn(mapping, routing)
        for obsolete in (
            "search_creators({id})",
            "rank_mcns({id})",
            "create_with_distributions({id",
            "ingest_mcn_submissions({inquiry_id",
        ):
            self.assertNotIn(obsolete, routing)

    def test_workflow_reference_contains_exact_machine_phases_and_recovery_order(self):
        text = read(REFERENCES / "workflow-state-machine.md")
        for phase in self.workflow["phases"]:
            self.assertIn(f"`{phase}`", text)
        for required in (
            "distribution_sync_pending",
            "首次成功 sync",
            "manual",
            "scheduled",
            "ctx.trigger=cron",
            "recovery_sync_pending",
            "最终 sync",
            "RECOVERY_ALREADY_TERMINAL",
        ):
            self.assertIn(required, text)

    def test_send_and_recovery_docs_are_fail_closed(self):
        joined = "\n".join(
            read(path)
            for path in [SKILL, *(REFERENCES.glob("*.md")), *(TOOLS_DIR.glob("*.md"))]
        )
        for required in (
            "preview_only=false",
            "sessionKey",
            "toolCallId",
            "supplyConfirmed",
            "mcnConfirmed",
            "messageConfirmed",
            "普通消息不解除等待",
            "不得把 reference MCP 的 simulated=true 当作生产成功",
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

    def test_provider_mismatch_is_a_hard_integration_error(self):
        joined = "\n".join((read(SKILL), read(ROOT / "README.md"), read(PACKAGE / "README.md")))
        for required in (
            "legacy-1.9.4",
            "select_inquiry_form_fields",
            "create_with_distributions",
            "sync_mcn_inquiry_status",
            "integration_required",
            "check-provider-contract.mjs",
        ):
            self.assertIn(required, joined)
        self.assertNotIn("自动降级", joined)

    def test_reference_file_inventory_is_exact(self):
        actual = {path.name for path in REFERENCES.glob("*.md")}
        self.assertEqual(EXPECTED_REFERENCE_FILES, actual)

    def test_csv_authority_keeps_supplied_line_count_fields_and_hash(self):
        raw = CSV_SCHEMA.read_bytes()
        self.assertEqual(EXPECTED_CSV_SHA256, hashlib.sha256(raw).hexdigest())
        with CSV_SCHEMA.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(153, len(rows))
        fields = [row["字段"] for row in rows]
        self.assertEqual(len(fields), len(set(fields)))
        for field in (
            "platform",
            "raw_messages_json",
            "budget_min_cents",
            "rebate_min_rate",
            "quantity_total",
            "project_name",
        ):
            self.assertIn(field, fields)

    def test_hook_reference_matches_registered_safe_event_surface(self):
        text = read(REFERENCES / "hook-behavior.md")
        for event in (
            "before_tool_call",
            "after_tool_call",
            "tool_result_persist",
            "message_received",
            "agent_turn_prepare",
            "session_end",
        ):
            self.assertIn(f"`{event}`", text)
        for required in ("TTL", "会话投影", "不改写工具结果", "不记录 payload"):
            self.assertIn(required, text)

    def test_hook_docs_map_public_projection_to_machine_phases(self):
        text = read(REFERENCES / "hook-behavior.md")
        for required in (
            "14 个机器阶段",
            "project_distribution_completed",
            "distribution_sync_pending",
            "spec/workflow.json",
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
            "统一验证覆盖 178 项测试",
            "人类文档同步、自动提交与精简度：5 项",
            "根 workspace 安装图：1 项",
            "reference MCP 与 provider checker：8 项",
            "Skill、工具卡和文档一致性：16 项",
        ):
            self.assertIn(required, text)
        self.assertNotIn("统一验证覆盖 175 项测试", text)

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
        paths = [ROOT / "AGENTS.md", ROOT / "README.md", PACKAGE / "README.md", SKILL]
        paths.extend(REFERENCES.glob("*.md"))
        paths.extend(TOOLS_DIR.glob("*.md"))
        joined = "\n".join(read(path) for path in paths if path.exists())
        self.assertNotIn("/Users/", joined)
        self.assertNotIn("pip install", joined)


if __name__ == "__main__":
    unittest.main()
