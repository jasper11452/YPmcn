# 脚本安装和调用指南

这些自检脚本是插件随包文件，只依赖 Python 3 标准库。运行时不要安装 `uv`、`pip` 包或 npm 依赖；不要把安装步骤放进业务流程。

## 环境要求

- 在插件根目录运行，即包含 `scripts/`、`skills/`、`openclaw.plugin.json` 的目录。
- 使用系统 `python3`。macOS 和多数 Linux 环境已内置或由宿主机预装。
- 首次执行不需要下载依赖；如果 `python3 --version` 不存在，停止并让用户安装 Python 3，不要自行联网安装。

## 调用格式

脚本从 stdin 读取 JSON，向 stdout 输出 JSON。只看输出中的 `ok`：

```bash
python3 scripts/check_flow_order.py <<'JSON'
{"visited_steps":["validate_requirement"],"intent_tool":"search_creators"}
JSON
```

成功输出必须是：

```json
{"ok": true}
```

如果输出 `{"ok": false, "errors": [...]}` 或命令非 0，先修正待调用参数或流程状态，不得继续调用业务工具。

## 何时调用

| 场景 | 命令 | stdin JSON |
|---|---|---|
| 每次业务工具前 | `python3 scripts/check_flow_order.py` | `visited_steps` + `intent_tool` |
| `validate_requirement` 前 | `python3 scripts/check_requirement_params.py` | `params` + 可选 `raw_text` |
| `create_with_distributions` 前 | `python3 scripts/check_distribution_readiness.py` | `gate_state` + `params` |

## 正确示例

`validate_requirement` 前同时跑流程顺序和参数精度检查：

```bash
python3 scripts/check_flow_order.py <<'JSON'
{"visited_steps":[],"intent_tool":"validate_requirement"}
JSON

python3 scripts/check_requirement_params.py <<'JSON'
{"params":{"platform":"xhs","submission_deadline_at":"2026-07-10T18:00:00+08:00","submission_deadline_raw":"7月10日18点","raw_messages_json":"[\"小红书10位美妆达人，预算3万以内，返点20%，7月10日18点前提交\"]","budget_min_cents":0,"budget_max_cents":3000000,"budget_raw":"3万以内","rebate_min_rate":0.2,"rebate_raw":"20%","quantity_total":10},"raw_text":"小红书10位美妆达人，预算3万以内，返点20%，7月10日18点前提交"}
JSON
```

## 常见错误

- 不要运行 `uv run scripts/check_requirement_params.py`；运行时不依赖 `uv`。
- 不要只写命令不传 stdin；无输入会返回 `{"ok": false}`。
- 不要从仓库根目录或上级目录运行；相对路径必须以插件根目录为准。
- 不要把脚本输出当业务工具结果；它只是调用前闸门。