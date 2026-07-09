import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

function runScript(scriptPath, input) {
  const output = execFileSync("uv", ["run", scriptPath], {
    cwd: new URL("..", import.meta.url),
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function packageFiles() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output);
  return pack.files.map(({ path }) => path);
}

describe("workflow helper scripts", () => {
  it("accepts canonical WeCom selection gate order", () => {
    const result = runScript("scripts/check_flow_order.py", {
      visited_steps: ["rank_mcns", "confirm-supply-ratio"],
      intent_tool: "mcn-select-for-wechat",
    });

    assert.deepEqual(result, { ok: true });
  });

  it("accepts canonical WeCom send gate order", () => {
    const result = runScript("scripts/check_flow_order.py", {
      visited_steps: ["confirm-wecom-permission"],
      intent_tool: "mcn-wechat-send",
    });

    assert.deepEqual(result, { ok: true });
  });

  it("accepts canonical distribution gate state", () => {
    const result = runScript("scripts/check_distribution_readiness.py", {
      gate_state: {
        "confirm-structured-brief": true,
        "confirm-supply-ratio": true,
        "mcn-select-for-wechat": true,
        "confirm-form-fields": true,
        "confirm-wecom-permission": true,
        "mcn-wechat-send": true,
      },
      params: {
        id: "mcn-plan-1",
        deadline: "2099-07-10T18:00:00+08:00",
        supplierIds: ["supplier-1"],
        usageScope: "project",
      },
    });

    assert.deepEqual(result, { ok: true });
  });

  it("packages workflow helper scripts", () => {
    const files = packageFiles();

    assert.ok(files.includes("scripts/check_flow_order.py"));
    assert.ok(files.includes("scripts/check_requirement_params.py"));
    assert.ok(files.includes("scripts/check_distribution_readiness.py"));
    assert.ok(files.includes("scripts/send_wecom.py"));
    assert.ok(!files.some((path) => path.includes("__pycache__")));
  });
});
