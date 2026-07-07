#!/usr/bin/env python3
"""Send messages to WeChat Work (企业微信) via group bot webhook."""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def send_wecom_message(webhook_url: str, content: str, msg_type: str = "markdown") -> dict:
    """Send a message to WeChat Work group bot.

    Args:
        webhook_url: The full webhook URL from WeChat Work bot settings.
        content: Message body text.
        msg_type: "markdown" or "text".

    Returns:
        Parsed JSON response from the webhook, or an error dict on failure.
    """
    body: dict = {"msgtype": msg_type}
    if msg_type == "markdown":
        body["markdown"] = {"content": content}
    else:
        body["text"] = {"content": content}

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"errcode": -1, "errmsg": f"HTTP {e.code}: {e.reason}"}
    except Exception as e:
        return {"errcode": -1, "errmsg": str(e)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Send WeChat Work messages via bot webhook",
    )
    parser.add_argument("--webhook", help="WeChat Work bot webhook URL (or set WECOM_WEBHOOK_URL)")
    parser.add_argument("--message", help="Message content (reads stdin if omitted)")
    parser.add_argument(
        "--type",
        choices=["markdown", "text"],
        default="markdown",
        dest="msg_type",
        help="Message type (default: markdown)",
    )
    args = parser.parse_args()

    webhook_url = args.webhook or os.environ.get("WECOM_WEBHOOK_URL")
    if not webhook_url:
        print("Error: webhook URL required via --webhook or WECOM_WEBHOOK_URL", file=sys.stderr)
        sys.exit(1)

    content = args.message or sys.stdin.read().strip()
    if not content:
        print("Error: message content required via --message or stdin", file=sys.stderr)
        sys.exit(1)

    result = send_wecom_message(webhook_url, content, args.msg_type)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("errcode") != 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
