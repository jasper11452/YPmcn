from pathlib import Path


ROOT = Path(__file__).parents[2]


def test_required_top_level_paths_exist() -> None:
    required = [
        "apps/mcp-server/main.py",
        "apps/workflow-engine/state_store.py",
        "apps/algorithm-engine/ranking_strategies.py",
        "db/migrations/020_mcp_tool_call_ledger.sql",
        "shared/schemas/requirement_schema.py",
    ]

    missing = [path for path in required if not (ROOT / path).is_file()]

    assert not missing, f"Missing required paths: {missing}"
