#!/usr/bin/env python3
"""test_hooks.py - Comprehensive tests for pre_tool_guard and post_tool_update hooks."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HOOKS_DIR = PROJECT_ROOT / "YPmcn" / "hooks"
STATE_DIR = PROJECT_ROOT / "YPmcn" / "state"
STATE_FILE = STATE_DIR / "session_guard.json"
PRE_TOOL = HOOKS_DIR / "pre_tool_guard.py"
POST_TOOL = HOOKS_DIR / "post_tool_update.py"
CLEANUP = HOOKS_DIR / "session_cleanup.py"

PASS, FAIL = 0, 0
SESSION_KEY = "test-session-001"
NOW_ISO = "2026-07-16T10:00:00+08:00"
FUTURE_DEADLINE = "2026-08-16T10:00:00+08:00"
PAST_DEADLINE = "2025-01-01T10:00:00+08:00"


def run_hook(script, payload):
    result = subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
    )
    try:
        return json.loads(result.stdout.strip())
    except json.JSONDecodeError:
        return {"raw_stdout": result.stdout, "raw_stderr": result.stderr, "rc": result.returncode}


def assert_allow(label, output):
    global PASS, FAIL
    decision = output.get("hookSpecificOutput", {}).get("permissionDecision")
    if decision == "allow":
        PASS += 1
        print(f"  PASS: {label}")
    else:
        FAIL += 1
        reason = output.get("hookSpecificOutput", {}).get("permissionDecisionReason", "?")
        print(f"  FAIL: {label} -> expected allow, got deny: {reason}")


def assert_deny(label, output, expected_code=None):
    global PASS, FAIL
    decision = output.get("hookSpecificOutput", {}).get("permissionDecision")
    reason = output.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
    if decision == "deny":
        if expected_code and expected_code not in reason:
            FAIL += 1
            print(f"  FAIL: {label} -> expected code {expected_code}, got: {reason}")
        else:
            PASS += 1
            print(f"  PASS: {label} -> {reason[:80]}")
    else:
        FAIL += 1
        print(f"  FAIL: {label} -> expected deny, got allow")


def assert_reference_context(label, output, tool, expected_references):
    global PASS, FAIL
    context = output.get("hookSpecificOutput", {}).get("additionalContext", "")
    required = [f"references/tools/{tool}.md", *expected_references]
    missing = [reference for reference in required if reference not in context]
    if not missing and "actually opened" in context:
        PASS += 1
        print(f"  PASS: {label}")
    else:
        FAIL += 1
        print(f"  FAIL: {label} -> missing={missing}, context={context!r}")


def set_state(session_key, session_data):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    data = {"schema_version": 1, "sessions": {}}
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    data["sessions"][session_key] = session_data
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def clear_state():
    if STATE_FILE.exists():
        os.remove(STATE_FILE)


# ============================================================================
# TEST 1: pre_tool_guard - Bash bypass detection
# ============================================================================
print("\n=== TEST 1: Bash bypass detection ===")

clear_state()

output = run_hook(PRE_TOOL, {
    "tool_name": "Bash",
    "tool_input": {"command": "curl -X POST https://api/create-with-distributions"}
})
assert_deny("Bash curl to provider API", output, "INTEGRATION_REQUIRED")

output = run_hook(PRE_TOOL, {
    "tool_name": "Bash",
    "tool_input": {"command": "echo hello"}
})
# Bash echo without provider pattern should be passed to next layer
print("  SKIP: Bash echo (not a provider write pattern) passed to matcher")


# ============================================================================
# TEST 2: pre_tool_guard - Phase mismatch
# ============================================================================
print("\n=== TEST 2: Phase mismatch ===")

set_state(SESSION_KEY, {
    "phase": "requirement_draft",
    "ids": {},
    "confirmations": {"supplyConfirmed": False, "mcnConfirmed": False, "messageConfirmed": False},
    "field_selection": {"selected": False, "fieldNames": []},
    "sync": {"first_sync_done": False, "latest_lifecycle": None},
})

output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__search_creators",
    "tool_input": {"id": "req_123"},
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_deny("search_creators from requirement_draft", output, "BLOCKED_PHASE_MISMATCH")

output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__validate_requirement",
    "tool_input": {"payload": {}},
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_allow("validate_requirement from requirement_draft", output)
assert_reference_context(
    "validate_requirement receives soft reference gate",
    output,
    "validate_requirement",
    [
        "references/contract-gate.md",
        "references/phase-tool-matrix.md",
        "references/requirement-intake.md",
        "references/requirement-parsing.md",
    ],
)


# ============================================================================
# TEST 3: pre_tool_guard - Distribution send guard (missing confirmation)
# ============================================================================
print("\n=== TEST 3: Distribution send guard ===")

set_state(SESSION_KEY, {
    "phase": "field_selection_ready",
    "ids": {"requirement_id": "req_123", "mcn_recommendation_id": "mcn_789"},
    "confirmations": {"supplyConfirmed": False, "mcnConfirmed": False, "messageConfirmed": False},
    "field_selection": {"selected": True, "fieldNames": ["creator_name", "price"]},
    "sync": {"first_sync_done": False, "latest_lifecycle": None},
})

output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__create_with_distributions",
    "tool_input": {
        "projectName": "test",
        "deadline": FUTURE_DEADLINE,
        "columns": [{"creator_name": "test"}, {"price": "100"}],
        "supplierIds": ["s1"],
    },
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_deny("send without confirmations", output, "BLOCKED_CONFIRMATION_REQUIRED")

# With confirmations but missing deadline timezone
set_state(SESSION_KEY, {
    "phase": "field_selection_ready",
    "ids": {"requirement_id": "req_123", "mcn_recommendation_id": "mcn_789"},
    "confirmations": {"supplyConfirmed": True, "mcnConfirmed": True, "messageConfirmed": True},
    "field_selection": {"selected": True, "fieldNames": ["creator_name", "price"]},
    "sync": {"first_sync_done": False, "latest_lifecycle": None},
})

output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__create_with_distributions",
    "tool_input": {
        "projectName": "test",
        "deadline": "2026-08-16",  # no timezone
        "columns": [{"creator_name": "test"}, {"price": "100"}],
        "supplierIds": ["s1"],
    },
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_deny("send with bad deadline format", output, "BLOCKED_INVALID_DEADLINE")

# With past deadline
output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__create_with_distributions",
    "tool_input": {
        "projectName": "test",
        "deadline": PAST_DEADLINE,
        "columns": [{"creator_name": "test"}, {"price": "100"}],
        "supplierIds": ["s1"],
    },
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_deny("send with past deadline", output, "BLOCKED_PAST_TIME")

# All valid
output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__create_with_distributions",
    "tool_input": {
        "projectName": "test",
        "deadline": FUTURE_DEADLINE,
        "columns": [{"creator_name": "test"}, {"price": "100"}],
        "supplierIds": ["s1"],
    },
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_allow("send with all guards passed", output)


# ============================================================================
# TEST 4: pre_tool_guard - Terminal phase lock
# ============================================================================
print("\n=== TEST 4: Terminal phase lock ===")

set_state(SESSION_KEY, {
    "phase": "recovered",
    "ids": {"requirement_id": "req_123", "run_id": "run_456"},
    "confirmations": {"supplyConfirmed": True, "mcnConfirmed": True, "messageConfirmed": True},
    "field_selection": {"selected": True, "fieldNames": ["creator_name"]},
    "sync": {"first_sync_done": True, "latest_lifecycle": "recovered"},
})

output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__sync_mcn_inquiry_status",
    "tool_input": {"requirement_id": "req_123", "project_id": "proj_1", "mcn_id": "mcn_1"},
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_deny("sync from recovered phase", output, "RECOVERY_ALREADY_TERMINAL")

output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__rank_creators",
    "tool_input": {"requirement_id": "req_123", "limit": 10},
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_allow("rank_creators from recovered phase", output)


# ============================================================================
# TEST 5: pre_tool_guard - Semantic ID mismatch
# ============================================================================
print("\n=== TEST 5: Semantic ID mismatch ===")

set_state(SESSION_KEY, {
    "phase": "recovered",
    "ids": {"requirement_id": "req_123", "run_id": "run_456"},
    "confirmations": {"supplyConfirmed": True, "mcnConfirmed": True, "messageConfirmed": True},
    "field_selection": {"selected": True, "fieldNames": ["creator_name"]},
    "sync": {"first_sync_done": True, "latest_lifecycle": "recovered"},
})

output = run_hook(PRE_TOOL, {
    "tool_name": "mcp__ypmcn__rank_creators",
    "tool_input": {"requirement_id": "req_wrong", "limit": 10},
    "sessionKey": SESSION_KEY,
    "toolCallId": "tc_001",
})
assert_deny("rank_creators with wrong requirement_id", output, "BLOCKED_SEMANTIC_ID_MISMATCH")


# ============================================================================
# TEST 6: post_tool_update - Full 14-phase state machine
# ============================================================================
print("\n=== TEST 6: post_tool_update - Full state machine ===")

clear_state()

def post_tool(tool_name, tool_input, result, session_key=SESSION_KEY, trigger=None):
    payload = {
        "tool_name": f"mcp__ypmcn__{tool_name}",
        "tool_input": tool_input,
        "result": result,
        "sessionKey": session_key,
    }
    if trigger:
        payload["recoveryTrigger"] = trigger
        payload["tool_input"]["recoveryTrigger"] = trigger
    run_hook(POST_TOOL, payload)

def read_state(session_key=SESSION_KEY):
    if not STATE_FILE.exists():
        return None
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("sessions", {}).get(session_key)

def assert_phase(label, expected_phase):
    global PASS, FAIL
    state = read_state()
    phase = state.get("phase") if state else None
    if phase == expected_phase:
        PASS += 1
        print(f"  PASS: {label} -> {phase}")
    else:
        FAIL += 1
        print(f"  FAIL: {label} -> expected {expected_phase}, got {phase}")
        if state:
            print(f"    state: {json.dumps(state, ensure_ascii=False)}")

# Step 1: validate_requirement
post_tool("validate_requirement", {"payload": {}},
          {"success": True, "data": {"id": "req_001", "status": "ready"}})
assert_phase("validate_requirement -> requirement_ready", "requirement_ready")

# Step 2: search_creators
post_tool("search_creators", {"id": "req_001"},
          {"success": True, "data": {"results": []}})
assert_phase("search_creators -> search_completed", "search_completed")

# Step 3: rank_mcns
post_tool("rank_mcns", {"id": "req_001", "platform": "xhs"},
          {"success": True, "data": {"mcn_recommendation_id": "mcn_001"}})
assert_phase("rank_mcns -> mcn_planning", "mcn_planning")

# Step 4: select_inquiry_form_fields
post_tool("select_inquiry_form_fields", {},
          {"success": True, "data": {"description": "creator_name：达人名\nprice：报价"}})
assert_phase("select_inquiry_form_fields -> field_selection_ready", "field_selection_ready")

# Step 5: create_with_distributions (need to set confirmations first)
state = read_state()
state["confirmations"] = {"supplyConfirmed": True, "mcnConfirmed": True, "messageConfirmed": True}
state["field_selection"] = {"selected": True, "fieldNames": ["creator_name", "price"]}
set_state(SESSION_KEY, state)

post_tool("create_with_distributions",
          {"projectName": "test", "deadline": FUTURE_DEADLINE, "columns": [], "supplierIds": ["s1"]},
          {"success": True, "data": {"project_id": "proj_001", "mcn_id": "mcn_a"}})
assert_phase("create_with_distributions -> distribution_sync_pending", "distribution_sync_pending")

# Step 6: sync_mcn_inquiry_status (first sync)
post_tool("sync_mcn_inquiry_status",
          {"requirement_id": "req_001", "project_id": "proj_001", "mcn_id": "mcn_a"},
          {"success": True, "data": {"inquiry_id": "inq_001"}})
assert_phase("first sync -> waiting_return", "waiting_return")

# Step 7: recovery sync (manual trigger)
post_tool("sync_mcn_inquiry_status",
          {"requirement_id": "req_001", "project_id": "proj_001", "mcn_id": "mcn_a"},
          {"success": True, "data": {"inquiry_id": "inq_001"}},
          trigger="manual")
assert_phase("recovery sync -> recovering", "recovering")

# Step 8: ingest_mcn_submissions
post_tool("ingest_mcn_submissions",
          {"inquiry_id": "inq_001", "items": []},
          {"success": True, "data": {}},
          trigger="manual")
assert_phase("ingest -> recovery_sync_pending", "recovery_sync_pending")

# Step 9: final sync
post_tool("sync_mcn_inquiry_status",
          {"requirement_id": "req_001", "project_id": "proj_001", "mcn_id": "mcn_a"},
          {"success": True, "data": {}},
          trigger="manual")
assert_phase("final sync -> recovered", "recovered")

# Step 10: rank_creators
post_tool("rank_creators",
          {"requirement_id": "req_001", "limit": 10},
          {"success": True, "data": {"run_id": "run_001"}})
assert_phase("rank_creators -> recommendation_ready", "recommendation_ready")

# Step 11: create_submission_batch
post_tool("create_submission_batch",
          {"run_id": "run_001"},
          {"success": True, "data": {"batch_id": "batch_001"}})
assert_phase("create_submission_batch -> submission_batch_ready", "submission_batch_ready")

# Step 12: record_client_feedback
post_tool("record_client_feedback",
          {"run_id": "run_001", "feedback_items": []},
          {"success": True, "data": {}})
assert_phase("record_client_feedback -> feedback_routing", "feedback_routing")


# ============================================================================
# TEST 7: post_tool_update - Error handling
# ============================================================================
print("\n=== TEST 7: post_tool_update - Error handling ===")

clear_state()
set_state(SESSION_KEY, {
    "phase": "requirement_draft",
    "ids": {},
})

post_tool("validate_requirement", {"payload": {}},
          {"success": False, "isError": True, "error": "bad input"})

state = read_state()
phase = state.get("phase") if state else None
issue = state.get("lastResultIssue") if state else None
if phase == "requirement_draft" and issue and issue.get("code") == "WRITE_RESULT_UNKNOWN":
    PASS += 1
    print("  PASS: error result -> phase unchanged, result issue recorded")
else:
    FAIL += 1
    print(f"  FAIL: error result handling. phase={phase}, issue={issue}")


# ============================================================================
# TEST 8: session_cleanup - Expired session removal
# ============================================================================
print("\n=== TEST 8: session_cleanup - Expired session removal ===")

# Create an old session
old_session = {
    "phase": "requirement_draft",
    "ids": {},
    "_updated_at_ms": 1000,
}
set_state("old-session", old_session)
set_state("fresh-session", {
    "phase": "recovered",
    "ids": {},
    "_updated_at_ms": 9999999999999,
})

run_hook(CLEANUP, {"sessionKey": "irrelevant"})

data = {}
if STATE_FILE.exists():
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
sessions = data.get("sessions", {})

if "old-session" not in sessions and "fresh-session" in sessions:
    PASS += 1
    print("  PASS: old session cleaned up, fresh session retained")
else:
    FAIL += 1
    print(f"  FAIL: sessions={list(sessions.keys())}")


# ============================================================================
# SUMMARY
# ============================================================================
print(f"\n{'='*50}")
print(f"RESULTS: {PASS} PASS, {FAIL} FAIL, {PASS + FAIL} total")
if FAIL > 0:
    print(f"FAILURES: {FAIL}")
    sys.exit(1)
else:
    print("ALL TESTS PASSED")
    sys.exit(0)
