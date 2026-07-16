#!/usr/bin/env python3
"""session_cleanup.py - Stop hook: delete expired session projections.

Runs on session end / stop events. Cleans up expired session entries from
.claude/state/session_guard.json based on 24h TTL.
"""
import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = Path(os.environ.get("YPMCN_STATE_FILE", PROJECT_ROOT / "state" / "session_guard.json"))
TTL_MS = 24 * 60 * 60 * 1000


def now_ms():
    from datetime import datetime, timezone
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def main():
    payload = {}
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, IOError):
        pass

    session_key = (
        payload.get("sessionKey") or
        payload.get("session_key") or
        payload.get("session_id") or
        (payload.get("context", {}) or {}).get("sessionKey") or
        (payload.get("context", {}) or {}).get("session_id") or
        ""
    )

    if not STATE_FILE.exists():
        sys.exit(0)

    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        sys.exit(0)

    if not isinstance(data, dict):
        sys.exit(0)

    sessions = data.get("sessions", {})
    changed = False

    if session_key and session_key in sessions:
        del sessions[session_key]
        changed = True

    cutoff = now_ms() - TTL_MS
    expired = [
        k for k, v in list(sessions.items())
        if isinstance(v, dict) and v.get("_updated_at_ms", 0) < cutoff
    ]
    for k in expired:
        del sessions[k]
        changed = True

    if not changed:
        sys.exit(0)

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(STATE_FILE) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    import os
    os.replace(tmp, STATE_FILE)


if __name__ == "__main__":
    main()
