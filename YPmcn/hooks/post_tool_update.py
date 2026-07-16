#!/usr/bin/env python3
"""post_tool_update.py - PostToolUse hook: extract evidence + advance state.

Reads .claude/state/session_guard.json, extracts success evidence from tool
results, advances the 14-phase state machine, and writes back.

Design: PreToolUse reads-only, PostToolUse writes-only. No cross-contamination.
"""
import json
import sys
import os
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = Path(os.environ.get("YPMCN_STATE_FILE", PROJECT_ROOT / "state" / "session_guard.json"))
TTL_SECONDS = 24 * 60 * 60

TOOL_NAME_PREFIXES = [
    "ypmcn__",
    "mcp__ypmcn__",
    "ypmcn-mcp__",
    "ypmcn-provider__",
]


def normalize_tool_name(tool_name):
    if not tool_name:
        return None
    lower = tool_name.lower()
    for prefix in TOOL_NAME_PREFIXES:
        if tool_name.startswith(prefix):
            candidate = tool_name[len(prefix):]
            return candidate if candidate else None
    return None


def nonempty_string(value):
    return isinstance(value, str) and value.strip() != ""


def load_state():
    if not STATE_FILE.exists():
        return {"schema_version": 1, "sessions": {}}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not isinstance(data, dict):
                return {"schema_version": 1, "sessions": {}}
            return data
    except (json.JSONDecodeError, IOError):
        return {"schema_version": 1, "sessions": {}}


def save_state(data):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(STATE_FILE) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def now_ms():
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def expire_sessions(data):
    sessions = data.get("sessions", {})
    cutoff = now_ms() - (TTL_SECONDS * 1000)
    expired = [
        k for k, v in sessions.items()
        if isinstance(v, dict) and v.get("_updated_at_ms") is not None and v.get("_updated_at_ms", 0) < cutoff
    ]
    for k in expired:
        del sessions[k]
    return data


def unwrap_result(value):
    if not isinstance(value, dict):
        return value
    if value.get("isError") is True:
        return value
    if "result" in value:
        return unwrap_result(value["result"])
    if "structuredContent" in value:
        return unwrap_result(value["structuredContent"])
    content = value.get("content")
    if isinstance(content, list):
        for entry in content:
            if not isinstance(entry, dict) or not isinstance(entry.get("text"), str):
                continue
            try:
                parsed = json.loads(entry["text"])
                return unwrap_result(parsed)
            except (json.JSONDecodeError, TypeError):
                pass
    return value


def observed_success(result):
    root = unwrap_result(result)
    if not isinstance(root, dict):
        return None
    if root.get("isError") is True or root.get("success") is not True:
        return None
    if "error" in root and root["error"] is not None:
        return None
    return {
        "root": root,
        "data": root.get("data") if isinstance(root.get("data"), dict) else None,
        "trace_id": root.get("trace_id") if nonempty_string(root.get("trace_id")) else None,
    }


def explicit_string(evidence, *keys):
    for source in (evidence.get("data"), evidence.get("root")):
        if not isinstance(source, dict):
            continue
        for key in keys:
            val = source.get(key)
            if nonempty_string(val):
                return val
    return None


def parse_field_selection(evidence):
    description = explicit_string(evidence, "description")
    if not description:
        return None
    field_names = []
    for line in description.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        for sep in ("：", ":"):
            if sep in line:
                name = line.split(sep, 1)[0].strip()
                if name:
                    field_names.append(name)
                break
    return {"description": description, "fieldNames": field_names} if field_names else None


def summarize_search_creators(evidence):
    data = evidence.get("data")
    if not isinstance(data, dict):
        return {"candidateCount": 0, "withCreatorPriceCount": 0, "withRelationshipRebateCount": 0}
    creators = data.get("creators")
    if not isinstance(creators, list):
        creators = data.get("results")
    if not isinstance(creators, list):
        creators = []
    price_fields = (
        "kolOfficialPriceL1", "kolOfficialPriceL2", "kolOfficialPriceL3",
        "downloadPriceL1", "downloadPriceL2", "downloadPriceL3",
    )
    rebate_fields = ("rebate_min_rate", "rebate_max_rate")
    candidates = [item for item in creators if isinstance(item, dict)]
    return {
        "candidateCount": len(candidates),
        "withCreatorPriceCount": sum(
            1 for item in candidates if any(item.get(field) is not None for field in price_fields)
        ),
        "withRelationshipRebateCount": sum(
            1 for item in candidates if any(item.get(field) is not None for field in rebate_fields)
        ),
    }


def mark_result_issue(session, tool_name, code):
    session["lastResultIssue"] = {
        "toolName": tool_name,
        "code": code,
        "at": now_ms(),
    }
    return session


def clear_result_issue(session):
    session.pop("lastResultIssue", None)
    return session


def ensure_session(session):
    if session is None:
        return {
            "phase": "requirement_draft",
            "ids": {},
            "confirmations": {"supplyConfirmed": False, "mcnConfirmed": False, "messageConfirmed": False},
            "field_selection": {"selected": False, "fieldNames": []},
            "sync": {"first_sync_done": False, "latest_lifecycle": None},
            "manualRecoveryConfirmedAt": None,
            "lastResultIssue": None,
        }
    session.setdefault("ids", {})
    session.setdefault("confirmations", {"supplyConfirmed": False, "mcnConfirmed": False, "messageConfirmed": False})
    session.setdefault("field_selection", {"selected": False, "fieldNames": []})
    session.setdefault("sync", {"first_sync_done": False, "latest_lifecycle": None})
    session.setdefault("manualRecoveryConfirmedAt", None)
    return session


def apply_result(tool, session, tool_input, evidence, trigger):
    session = ensure_session(session)

    if tool == "validate_requirement":
        req_id = explicit_string(evidence, "requirement_id", "id")
        if not req_id:
            return mark_result_issue(session, tool, "WRITE_RESULT_UNKNOWN")
        clear_result_issue(session)
        session["phase"] = "requirement_ready"
        session["ids"]["requirement_id"] = req_id
        return session

    if tool == "search_creators":
        if session.get("phase") != "requirement_ready":
            return session
        if tool_input.get("id") != session.get("ids", {}).get("requirement_id"):
            return session
        clear_result_issue(session)
        session["phase"] = "search_completed"
        session["search_result"] = summarize_search_creators(evidence)
        return session

    if tool == "rank_mcns":
        if session.get("phase") != "search_completed":
            return session
        if tool_input.get("id") != session.get("ids", {}).get("requirement_id"):
            return session
        rec_id = explicit_string(evidence, "mcn_recommendation_id", "id")
        if not rec_id:
            return mark_result_issue(session, tool, "WRITE_RESULT_UNKNOWN")
        clear_result_issue(session)
        session["phase"] = "mcn_planning"
        session["ids"]["mcn_recommendation_id"] = rec_id
        session["field_selection"] = {"selected": False, "fieldNames": []}
        session["confirmations"] = {"supplyConfirmed": False, "mcnConfirmed": False, "messageConfirmed": False}
        return session

    if tool == "select_inquiry_form_fields":
        if session.get("phase") != "mcn_planning":
            return session
        selection = parse_field_selection(evidence)
        if not selection:
            return mark_result_issue(session, tool, "INTEGRATION_REQUIRED")
        clear_result_issue(session)
        session["phase"] = "field_selection_ready"
        session["field_selection"] = {"selected": True, "fieldNames": selection["fieldNames"]}
        return session

    if tool == "create_with_distributions":
        if session.get("phase") != "field_selection_ready":
            return session
        project_id = explicit_string(evidence, "project_id")
        mcn_id = explicit_string(evidence, "mcn_id")
        if not project_id or not mcn_id:
            return mark_result_issue(session, tool, "WRITE_RESULT_UNKNOWN")
        clear_result_issue(session)
        session["phase"] = "distribution_sync_pending"
        session["ids"]["project_id"] = project_id
        session["ids"]["mcn_id"] = mcn_id
        return session

    if tool == "sync_mcn_inquiry_status":
        return apply_sync(session, evidence, tool_input, trigger)

    if tool == "ingest_mcn_submissions":
        return apply_ingest(session, evidence, tool_input, trigger)

    if tool == "rank_creators":
        if session.get("phase") != "recovered":
            return session
        if tool_input.get("requirement_id") != session.get("ids", {}).get("requirement_id"):
            return session
        run_id = explicit_string(evidence, "run_id")
        if not run_id:
            return mark_result_issue(session, tool, "WRITE_RESULT_UNKNOWN")
        clear_result_issue(session)
        session["phase"] = "recommendation_ready"
        session["ids"]["run_id"] = run_id
        return session

    if tool == "create_submission_batch":
        if session.get("phase") != "recommendation_ready":
            return session
        if tool_input.get("run_id") != session.get("ids", {}).get("run_id"):
            return session
        clear_result_issue(session)
        session["phase"] = "submission_batch_ready"
        return session

    if tool == "record_client_feedback":
        if session.get("phase") != "submission_batch_ready":
            return session
        if tool_input.get("run_id") != session.get("ids", {}).get("run_id"):
            return session
        clear_result_issue(session)
        session["phase"] = "feedback_routing"
        return session

    return session


def apply_sync(session, evidence, tool_input, trigger):
    req_id = tool_input.get("requirement_id")
    project_id = tool_input.get("project_id")
    mcn_id = tool_input.get("mcn_id")
    ids = session.get("ids", {})

    if not all(nonempty_string(v) for v in (req_id, project_id, mcn_id)):
        return session

    if ids.get("requirement_id") and ids["requirement_id"] != req_id:
        return session
    if ids.get("project_id") and ids["project_id"] != project_id:
        return session
    if ids.get("mcn_id") and ids["mcn_id"] != mcn_id:
        return session

    inquiry_id = explicit_string(evidence, "inquiry_id")
    ids["requirement_id"] = req_id
    ids["project_id"] = project_id
    ids["mcn_id"] = mcn_id
    if inquiry_id:
        ids["inquiry_id"] = inquiry_id

    phase = session.get("phase")
    sync_state = session.get("sync", {})

    if phase == "distribution_sync_pending":
        clear_result_issue(session)
        session["phase"] = "waiting_return"
        sync_state["first_sync_done"] = True
        sync_state["latest_lifecycle"] = "waiting_return"
        sync_state["last_sync_at"] = now_ms()
        session["sync"] = sync_state
        return session

    if phase == "waiting_return" and trigger:
        if not inquiry_id:
            return mark_result_issue(session, "sync_mcn_inquiry_status", "WRITE_RESULT_UNKNOWN")
        clear_result_issue(session)
        session["phase"] = "recovering"
        sync_state["latest_lifecycle"] = "recovering"
        sync_state["last_sync_at"] = now_ms()
        sync_state["recovery_trigger"] = trigger
        session["sync"] = sync_state
        return session

    if phase == "recovery_sync_pending":
        clear_result_issue(session)
        session["phase"] = "recovered"
        sync_state["latest_lifecycle"] = "recovered"
        sync_state["last_sync_at"] = now_ms()
        session["sync"] = sync_state
        return session

    return session


def apply_ingest(session, evidence, tool_input, trigger):
    if session.get("phase") != "recovering":
        return session

    inquiry_id = tool_input.get("inquiry_id")
    if not nonempty_string(inquiry_id) or inquiry_id != session.get("ids", {}).get("inquiry_id"):
        return session

    if not trigger:
        return session

    sync_state = session.get("sync", {})
    if not sync_state.get("first_sync_done"):
        return session

    clear_result_issue(session)
    session["phase"] = "recovery_sync_pending"
    sync_state["last_ingest_trigger"] = trigger
    session["sync"] = sync_state
    return session


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, IOError):
        sys.exit(0)

    raw_tool_name = (payload.get("tool_name") or payload.get("toolName") or "").strip()
    tool = normalize_tool_name(raw_tool_name)
    if not tool:
        sys.exit(0)

    tool_input_raw = payload.get("tool_input") or payload.get("toolInput") or {}
    if not isinstance(tool_input_raw, dict):
        tool_input_raw = {}

    result = payload.get("result") or payload.get("tool_result") or payload
    is_error = (
        payload.get("isError") or
        payload.get("is_error") or
        (isinstance(result, dict) and (result.get("isError") or result.get("success") is False))
    )

    session_key = (
        payload.get("sessionKey") or
        payload.get("session_key") or
        payload.get("session_id") or
        (payload.get("context", {}) or {}).get("sessionKey") or
        (payload.get("context", {}) or {}).get("session_id") or
        ""
    )
    if not nonempty_string(session_key):
        sys.exit(0)

    trigger = (
        payload.get("recoveryTrigger") or
        payload.get("recovery_trigger") or
        tool_input_raw.get("recoveryTrigger") or
        tool_input_raw.get("trigger")
    )

    data = load_state()
    data = expire_sessions(data)
    sessions = data.setdefault("sessions", {})

    session = sessions.get(session_key)
    if session is None:
        session = None

    if is_error:
        if session:
            session = mark_result_issue(session, tool, "WRITE_RESULT_UNKNOWN")
            session["_updated_at_ms"] = now_ms()
            sessions[session_key] = session
            save_state(data)
        sys.exit(0)

    evidence = observed_success(result)
    if not evidence:
        if session:
            session = mark_result_issue(session, tool, "WRITE_RESULT_UNKNOWN")
            session["_updated_at_ms"] = now_ms()
            sessions[session_key] = session
            save_state(data)
        sys.exit(0)

    session = apply_result(tool, session, tool_input_raw, evidence, trigger)
    if session:
        session["_updated_at_ms"] = now_ms()
        sessions[session_key] = session
        save_state(data)

    sys.exit(0)


if __name__ == "__main__":
    main()
