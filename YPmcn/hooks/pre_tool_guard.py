#!/usr/bin/env python3
"""pre_tool_guard.py - PreToolUse hook: 4-layer deterministic validation.

Layer 1: Tool whitelist + Bash bypass detection
Layer 2: Parameter schema check against spec
Layer 3: State machine phase validation
Layer 4: Side-effect protection (send guard, recovery, terminal lock)

Registered hook events (configured in .claude/settings.json):
  api.on("PreToolUse")   → pre_tool_guard.py
  api.on("PostToolUse")  → post_tool_update.py
  api.on("Stop")         → session_cleanup.py

Reads YPmcn/state/session_guard.json (read-only).
Outputs JSON with permissionDecision = "allow" or "deny".
"""
import json
import sys
import re
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = PROJECT_ROOT / "state" / "session_guard.json"

TERMINAL_PHASES = {"recovered", "closed"}

PHASE_ALLOWED_TOOLS = {
    "requirement_draft": {"validate_requirement"},
    "requirement_ready": {"search_creators"},
    "search_completed": {"rank_mcns"},
    "mcn_planning": {"select_inquiry_form_fields"},
    "field_selection_ready": {"create_with_distributions"},
    "distribution_sync_pending": {"sync_mcn_inquiry_status"},
    "waiting_return": {"sync_mcn_inquiry_status"},
    "recovering": {"ingest_mcn_submissions"},
    "recovery_sync_pending": {"sync_mcn_inquiry_status"},
    "recovered": {
        "manual_source_creators", "rank_creators",
    },
    "recommendation_ready": {"create_submission_batch"},
    "submission_batch_ready": {"record_client_feedback"},
    "feedback_routing": set(),
    "blocked": set(),
}

READ_ONLY_TOOLS = {
    "select_inquiry_form_fields",
    "get_recommendation_run_detail",
    "get_creator_detail",
    "audit_manual_adjustment",
    "get_workflow_state",
}

SEMANTIC_ID_RULES = {
    "search_creators": [("id", "requirement_id")],
    "rank_mcns": [("id", "requirement_id")],
    "rank_creators": [("requirement_id", "requirement_id")],
    "create_submission_batch": [("run_id", "run_id")],
    "record_client_feedback": [("run_id", "run_id")],
    "audit_manual_adjustment": [("run_id", "run_id")],
}

TOOL_NAME_PREFIXES = [
    "ypmcn__",
    "mcp__ypmcn__",
    "ypmcn-mcp__",
    "ypmcn-provider__",
]

SHELL_TOOLS = {"bash", "exec", "shell", "powershell", "pwsh"}
PROVIDER_WRITE_PATTERN = re.compile(
    r"(?:create[-_]with[-_]distributions|/api/projects/create-with-distributions)",
    re.IGNORECASE,
)
ISO_WITH_TIMEZONE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$"
)

SEND_ROLES = {"media", "procurement"}

COMMON_REFERENCES = [
    "references/contract-gate.md",
    "references/phase-tool-matrix.md",
]

SCENARIO_REFERENCES = {
    "validate_requirement": ["references/requirement-intake.md", "references/requirement-parsing.md"],
    "select_inquiry_form_fields": ["references/form-field-mapping.md", "references/ask-user-question-patterns.md"],
    "create_with_distributions": ["references/form-field-mapping.md", "references/ask-user-question-patterns.md"],
    "sync_mcn_inquiry_status": ["references/hook-behavior.md"],
    "ingest_mcn_submissions": ["references/hook-behavior.md"],
    "record_client_feedback": ["references/frontend-response.md"],
}


def load_state():
    if not STATE_FILE.exists():
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def get_session(state_data, session_key):
    sessions = state_data.get("sessions", {}) if isinstance(state_data, dict) else {}
    return sessions.get(session_key)


def reference_context(tool):
    references = [f"references/tools/{tool}.md", *COMMON_REFERENCES]
    references.extend(SCENARIO_REFERENCES.get(tool, ["references/mcp-tool-cheatsheet.md"]))
    ordered = list(dict.fromkeys(references))
    return (
        "SOFT_REFERENCE_GATE: Before executing this tool, read the current Skill references: "
        + ", ".join(ordered)
        + ". Also read any other reference linked by SKILL.md that is relevant to the user's current scenario. "
        + "Do not claim a reference was read unless it was actually opened in this session."
    )


def emit_allow(tool=None):
    hook_output = {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
    }
    if tool:
        hook_output["additionalContext"] = reference_context(tool)
    print(json.dumps({
        "hookSpecificOutput": {
            **hook_output,
        }
    }))
    sys.exit(0)


def emit_deny(code, message, details=None):
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"{code}: {message}",
        }
    }
    if details:
        out["details"] = details
    print(json.dumps(out))
    sys.exit(0)


def normalize_tool_name(tool_name):
    if not tool_name:
        return None
    lower = tool_name.lower()
    if lower in SHELL_TOOLS:
        return None
    for prefix in TOOL_NAME_PREFIXES:
        if tool_name.startswith(prefix):
            candidate = tool_name[len(prefix):]
            return candidate if candidate else None
    return None


def nonempty_string(value):
    return isinstance(value, str) and value.strip() != ""


def parse_deadline(value):
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo is not None else None
    except (ValueError, TypeError):
        return None


def column_contains_field(column, field_name):
    if not isinstance(column, dict):
        return False
    if field_name in column:
        return True
    return any(v == field_name for v in column.values() if isinstance(v, str))


# ---- Layer 1: Bash/shell bypass detection ----

def validate_bash(tool_name, tool_input):
    if tool_name.lower() not in SHELL_TOOLS:
        return
    command = ""
    for key in ("command", "cmd", "script", "input"):
        val = tool_input.get(key, "")
        if isinstance(val, str):
            command += val + "\n"
    if PROVIDER_WRITE_PATTERN.search(command):
        emit_deny(
            "INTEGRATION_REQUIRED",
            "Provider writes must use the declared MCP tool, not a shell or curl bypass."
        )
    emit_allow()


# ---- Layer 2+3: Phase + Semantic ID validation ----

def validate_phase_and_ids(tool, tool_input, session):
    phase = session.get("phase", "requirement_draft")

    if phase in TERMINAL_PHASES and tool not in READ_ONLY_TOOLS:
        if tool not in {"manual_source_creators", "rank_creators"} or phase == "closed":
            emit_deny(
                "RECOVERY_ALREADY_TERMINAL",
                f"current phase is terminal: {phase}, tool {tool} is blocked"
            )

    allowed = PHASE_ALLOWED_TOOLS.get(phase, set())
    if tool not in allowed and tool not in READ_ONLY_TOOLS:
        emit_deny(
            "BLOCKED_PHASE_MISMATCH",
            f"current phase={phase}, tool={tool} not allowed",
            {"phase": phase, "tool": tool, "allowed_tools": sorted(allowed)}
        )

    rules = SEMANTIC_ID_RULES.get(tool, [])
    ids = session.get("ids", {})
    for param_key, state_key in rules:
        input_val = tool_input.get(param_key)
        state_val = ids.get(state_key)
        if not nonempty_string(input_val):
            emit_deny(
                "BLOCKED_MISSING_SEMANTIC_IDS",
                f"missing {param_key} for tool={tool}"
            )
        if state_val and input_val != state_val:
            emit_deny(
                "BLOCKED_SEMANTIC_ID_MISMATCH",
                f"{param_key} mismatch: expected={state_val}, actual={input_val}",
                {"field": param_key, "expected": state_val, "actual": input_val}
            )

    validate_specific_phase_rules(tool, tool_input, session, phase)


def validate_specific_phase_rules(tool, tool_input, session, phase):
    if tool == "validate_requirement":
        if phase not in ("requirement_draft", "feedback_routing"):
            emit_deny(
                "INVALID_PHASE",
                f"Requirement validation is not allowed from {phase}."
            )

    if tool == "select_inquiry_form_fields" and phase != "mcn_planning":
        emit_deny("INVALID_PHASE", f"Field selection requires mcn_planning, current={phase}")

    if tool == "manual_source_creators" and phase != "recovered":
        emit_deny("INVALID_PHASE", f"Manual sourcing requires recovered, current={phase}")


# ---- Layer 4: Distribution send guard ----

def validate_distribution_send(tool_input, session):
    phase = session.get("phase")
    if phase != "field_selection_ready":
        emit_deny("INVALID_PHASE", f"Distribution write requires field_selection_ready, current={phase}")

    confirmations = session.get("confirmations", {})
    for key in ("supplyConfirmed", "mcnConfirmed", "messageConfirmed"):
        if confirmations.get(key) is not True:
            emit_deny("BLOCKED_CONFIRMATION_REQUIRED", f"{key}=false")

    field_sel = session.get("field_selection", {})
    if not field_sel.get("selected"):
        emit_deny("BLOCKED_FIELD_SELECTION_REQUIRED", "field selection not confirmed")

    expected_names = field_sel.get("fieldNames", [])
    columns = tool_input.get("columns", [])
    if not isinstance(columns, list) or len(columns) != len(expected_names):
        emit_deny(
            "BLOCKED_COLUMNS_MISMATCH",
            "columns count must match confirmed field selection",
            {"expected_count": len(expected_names), "actual_count": len(columns) if isinstance(columns, list) else 0}
        )
    for i, (col, name) in enumerate(zip(columns, expected_names)):
        if not isinstance(col, dict) or not column_contains_field(col, name):
            emit_deny(
                "BLOCKED_COLUMNS_MISMATCH",
                f"column[{i}] does not contain field '{name}'",
                {"index": i, "expected_field": name}
            )

    supplier_ids = tool_input.get("supplierIds", [])
    if not isinstance(supplier_ids, list) or len(supplier_ids) == 0:
        emit_deny("BLOCKED_EMPTY_SUPPLIER", "supplierIds must be non-empty")

    deadline = tool_input.get("deadline", "")
    if not nonempty_string(deadline) or not ISO_WITH_TIMEZONE.match(deadline):
        emit_deny("BLOCKED_INVALID_DEADLINE", "deadline must be ISO-8601 with timezone")
    dt = parse_deadline(deadline)
    if dt is None or dt <= datetime.now(timezone.utc):
        emit_deny("BLOCKED_PAST_TIME", "deadline must be in the future")


# ---- Layer 4: Sync guard ----

def validate_sync(tool_input, session):
    phase = session.get("phase")
    ids = session.get("ids", {})

    for key, state_key in [("requirement_id", "requirement_id"), ("project_id", "project_id"), ("mcn_id", "mcn_id")]:
        state_val = ids.get(state_key)
        input_val = tool_input.get(key)
        if state_val and input_val != state_val:
            emit_deny("STATE_CONFLICT", f"{key} does not match current-session evidence")

    if phase == "distribution_sync_pending":
        return

    if phase == "waiting_return":
        trigger = tool_input.get("recoveryTrigger") or tool_input.get("trigger")
        if trigger == "manual":
            manual_at = session.get("manualRecoveryConfirmedAt")
            if not manual_at:
                emit_deny("RECOVERY_NOT_CONFIRMED", "manual recovery requires explicit user intent in current session")
            return
        if trigger == "scheduled" and tool_input.get("trigger") == "cron":
            if not nonempty_string(tool_input.get("cron_job_id")):
                emit_deny("RECOVERY_NOT_CONFIRMED", "scheduled sync requires cron_job_id")
            return
        emit_deny("RECOVERY_NOT_CONFIRMED", "Recovery sync requires manual intent or cron evidence")

    if phase == "recovery_sync_pending":
        sync = session.get("sync", {})
        trigger = tool_input.get("recoveryTrigger") or tool_input.get("trigger")
        last_trigger = sync.get("last_ingest_trigger")
        if last_trigger and trigger != last_trigger:
            emit_deny("STATE_CONFLICT", "Final sync trigger does not match ingest trigger")
        return

    if phase == "recovered":
        emit_deny("RECOVERY_ALREADY_TERMINAL", "Local recovery sequence is already complete")

    emit_deny("INVALID_PHASE", f"Sync not allowed from phase={phase}")


# ---- Layer 4: Ingest guard ----

def validate_ingest(tool_input, session):
    phase = session.get("phase")
    if phase != "recovering":
        emit_deny("INVALID_PHASE", f"Ingest requires recovering, current={phase}")

    ids = session.get("ids", {})
    inquiry_id = ids.get("inquiry_id")
    input_inquiry = tool_input.get("inquiry_id")
    if inquiry_id and input_inquiry != inquiry_id:
        emit_deny("STATE_CONFLICT", "inquiry_id does not match current-session evidence")

    sync = session.get("sync", {})
    if not sync.get("first_sync_done"):
        emit_deny("RECOVERY_NOT_CONFIRMED", "Ingest requires successful current-session sync evidence")

    trigger = tool_input.get("recoveryTrigger") or tool_input.get("trigger")
    if trigger == "manual":
        manual_at = session.get("manualRecoveryConfirmedAt")
        if not manual_at:
            emit_deny("RECOVERY_NOT_CONFIRMED", "Ingest requires matching manual sync evidence")
    elif trigger == "scheduled":
        if tool_input.get("trigger") != "cron":
            emit_deny("RECOVERY_NOT_CONFIRMED", "Ingest requires matching cron sync evidence")


# ---- Result issue guard ----

def validate_result_issue(tool, session):
    issue = session.get("lastResultIssue")
    if not issue:
        return
    if tool in READ_ONLY_TOOLS:
        return
    emit_deny(
        issue.get("code", "WRITE_RESULT_UNKNOWN"),
        "Previous result lacked explicit evidence; reconcile before retrying this write."
    )


# ---- Main ----

def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, IOError) as e:
        emit_deny("HOOK_INPUT_ERROR", str(e))

    raw_tool_name = (payload.get("tool_name") or payload.get("toolName") or "").strip()
    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}

    if raw_tool_name.lower() in SHELL_TOOLS:
        validate_bash(raw_tool_name, tool_input)

    tool = normalize_tool_name(raw_tool_name)
    if not tool:
        emit_allow()

    if tool not in PHASE_ALLOWED_TOOLS.get("requirement_draft", set()) and \
       tool not in READ_ONLY_TOOLS and \
       tool not in {t for tools in PHASE_ALLOWED_TOOLS.values() for t in tools}:
        emit_allow(tool)

    session_key = (
        payload.get("sessionKey") or
        payload.get("session_key") or
        (payload.get("context", {}) or {}).get("sessionKey") or
        ""
    )
    if not nonempty_string(session_key) and tool not in READ_ONLY_TOOLS:
        emit_deny("INVALID_INPUT", "A current sessionKey is required for state-safe execution.")

    state = load_state()
    session = get_session(state, session_key) if session_key else None

    validate_result_issue(tool, session)

    if session:
        validate_phase_and_ids(tool, tool_input, session)

    if tool == "create_with_distributions":
        if not session:
            emit_deny("INTEGRATION_REQUIRED", "Current-session send evidence is missing.")
        validate_distribution_send(tool_input, session)

    if tool == "sync_mcn_inquiry_status":
        if not session:
            emit_deny("INTEGRATION_REQUIRED", "Current-session send evidence is missing.")
        validate_sync(tool_input, session)

    if tool == "ingest_mcn_submissions":
        if not session:
            emit_deny("INTEGRATION_REQUIRED", "Current-session send evidence is missing.")
        validate_ingest(tool_input, session)

    if tool not in READ_ONLY_TOOLS:
        tool_call_id = (
            payload.get("toolCallId") or
            payload.get("tool_call_id") or
            (payload.get("context", {}) or {}).get("toolCallId")
        )
        if not nonempty_string(tool_call_id):
            emit_deny("INVALID_INPUT", "A business write requires toolCallId evidence.")

    emit_allow(tool)


if __name__ == "__main__":
    main()
