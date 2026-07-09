#!/usr/bin/env python3
"""Block legacy direct WeCom webhook sends.

YPmcn project distribution is handled by the MCP tool
`create_with_distributions`; this script remains only to fail old calls with a
clear migration message.
"""

import json
import sys

ERROR = {
    "ok": False,
    "error": "send_wecom.py is deprecated; use MCP tool create_with_distributions for WeCom project distribution.",
}


def main() -> None:
    print(json.dumps(ERROR, ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
