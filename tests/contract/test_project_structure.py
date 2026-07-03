from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_required_top_level_paths_exist() -> None:
    required = [
        "apps/mcp-server/main.py",
        "apps/mcp-server/contract/response_envelope.py",
        "apps/mcp-server/contract/error_codes.py",
        "apps/mcp-server/contract/idempotency.py",
        "apps/mcp-server/tools/validate_requirement.py",
        "apps/mcp-server/tools/search_creators.py",
        "apps/mcp-server/tools/rank_mcns.py",
        "apps/mcp-server/tools/rank_creators.py",
        "apps/mcp-server/tools/create_submission_batch.py",
        "apps/mcp-server/tools/ingest_mcn_submissions.py",
        "apps/mcp-server/tools/manual_source_creators.py",
        "apps/mcp-server/tools/record_client_feedback.py",
        "apps/mcp-server/tools/audit_manual_adjustment.py",
        "apps/mcp-server/tools/get_workflow_state.py",
        "apps/mcp-server/tools/get_creator_detail.py",
        "apps/mcp-server/tools/get_recommendation_run_detail.py",
        "apps/mcp-server/tools/create_mcn_inquiries.py",
        "apps/workflow-engine/state_store.py",
        "apps/workflow-engine/phases/requirement_phase.py",
        "apps/workflow-engine/phases/screening_phase.py",
        "apps/workflow-engine/phases/mcn_planning_phase.py",
        "apps/workflow-engine/phases/ranking_phase.py",
        "apps/workflow-engine/phases/submission_phase.py",
        "apps/workflow-engine/gates/confirm_ready.py",
        "apps/workflow-engine/gates/confirm_medium_risk.py",
        "apps/workflow-engine/gates/confirm_risky_submission.py",
        "apps/workflow-engine/gates/confirm_mcn_selection.py",
        "apps/workflow-engine/gates/authorize_relaxation.py",
        "apps/workflow-engine/gates/manual_review_resume.py",
        "apps/algorithm-engine/filters/hard_filter.py",
        "apps/algorithm-engine/filters/soft_filter.py",
        "apps/algorithm-engine/scoring/creator_score.py",
        "apps/algorithm-engine/scoring/mcn_score.py",
        "apps/algorithm-engine/scoring/risk_penalty.py",
        "apps/algorithm-engine/supply_assessment.py",
        "apps/algorithm-engine/ranking_strategies.py",
        "apps/wecom-integration/message_router.py",
        "apps/wecom-integration/inquiry_notifier.py",
        "apps/wecom-integration/feedback_listener.py",
        "db/migrations/020_mcp_tool_call_ledger.sql",
        "shared/schemas/requirement_schema.py",
        "shared/schemas/score_detail_schema.py",
        "shared/schemas/formula_snapshot_schema.py",
        "shared/constants/platform_enum.py",
        "shared/constants/candidate_source_enum.py",
        "tests/tools/test_validate_requirement.py",
        "tests/tools/test_search_creators.py",
        "tests/tools/test_rank_mcns.py",
        "tests/tools/test_rank_creators.py",
        "tests/tools/test_create_submission_batch.py",
        "tests/tools/test_ingest_mcn_submissions.py",
        "tests/tools/test_manual_source_creators.py",
        "tests/tools/test_record_client_feedback.py",
        "tests/tools/test_audit_manual_adjustment.py",
        "tests/tools/test_get_creator_detail.py",
        "tests/tools/test_get_recommendation_run_detail.py",
        "tests/tools/test_create_mcn_inquiries.py",
        "tests/tools/test_get_workflow_state.py",
    ]

    missing = [path for path in required if not (ROOT / path).is_file()]

    assert not missing, f"Missing required paths: {missing}"


def test_required_admin_console_routes_exist() -> None:
    required = [
        "apps/admin-console/gate-approval",
        "apps/admin-console/manual-sourcing",
        "apps/admin-console/adjustment-review",
        "db/seeds",
    ]

    missing = [path for path in required if not (ROOT / path).is_dir()]

    assert not missing, f"Missing required directories: {missing}"
