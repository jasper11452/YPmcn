import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  expectedRequiredTools,
  loadContractProfile,
  loadDatabaseContract,
  loadErrorCatalog,
  loadWorkflowContract,
} from "../dist/contract/loader.js";
import {
  validateFieldSelection,
  validateToolParams,
} from "../dist/contract/validator.js";

const V2_REQUIRED_TOOLS = [
  "validate_requirement",
  "search_creators",
  "rank_mcns",
  "select_inquiry_form_fields",
  "create_with_distributions",
  "sync_mcn_inquiry_status",
  "ingest_mcn_submissions",
  "manual_source_creators",
  "rank_creators",
  "create_submission_batch",
  "record_client_feedback",
  "get_recommendation_run_detail",
  "get_creator_detail",
  "audit_manual_adjustment",
];

const LEGACY_OBSERVED_TOOLS = [
  "validate_requirement",
  "search_creators",
  "rank_mcns",
  "ingest_mcn_submissions",
  "manual_source_creators",
  "rank_creators",
  "create_submission_batch",
  "record_client_feedback",
  "get_recommendation_run_detail",
  "get_creator_detail",
  "audit_manual_adjustment",
];

const FIELD_ONE = {
  key: "creator_name",
  name: "达人昵称",
  type: "text",
  required: true,
};

const FIELD_TWO = {
  key: "quote_cents",
  name: "报价",
  type: "number",
  required: false,
};

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function assertIssueShape(issue) {
  assert.equal(typeof issue.code, "string");
  assert.equal(typeof issue.path, "string");
  assert.equal(typeof issue.message, "string");
  assert.notEqual(issue.message.length, 0);
}

function assertHasIssue(issues, code, path) {
  for (const issue of issues) assertIssueShape(issue);
  assert.ok(
    issues.some(
      (issue) => issue.code === code && (path === undefined || issue.path === path),
    ),
    `expected ${code}${path ? ` at ${path}` : ""}: ${JSON.stringify(issues)}`,
  );
}

function validDemand(overrides = {}) {
  return {
    platform: "xhs",
    submission_deadline_at: "2026-07-20T18:00:00+08:00",
    submission_deadline_raw: "7 月 20 日 18:00",
    raw_messages_json: "[]",
    budget_min_cents: 100_000,
    budget_max_cents: 300_000,
    budget_raw: "1000-3000 元",
    rebate_min_rate: 0.1,
    rebate_max_rate: 0.2,
    rebate_raw: "10%-20%",
    quantity_total: 10,
    ...overrides,
  };
}

function validDistribution(overrides = {}) {
  return {
    mcn_recommendation_id: "mcn-rec-1",
    projectName: "新品种草",
    description: "请按要求填写",
    deadline: "2026-07-20T18:00:00+08:00",
    remindAt: "2026-07-19T18:00:00+08:00",
    usageScope: "project",
    supplierIds: ["supplier-1"],
    columns: [{ ...FIELD_ONE }],
    sendWechatNotification: true,
    preview_only: false,
    ...overrides,
  };
}

function validFieldSelection(overrides = {}) {
  return {
    success: true,
    fields: {
      [FIELD_ONE.key]: { ...FIELD_ONE },
      [FIELD_TWO.key]: { ...FIELD_TWO },
    },
    items: [{ ...FIELD_ONE }, { ...FIELD_TWO }],
    selected_count: 2,
    ...overrides,
  };
}

describe("contract loader", () => {
  it("loads and caches the approved MVP V2 profile", () => {
    const first = loadContractProfile("mvp-v2");
    const second = loadContractProfile("mvp-v2");

    assert.equal(first.profile, "mvp-v2");
    assert.equal(first.mode, "writable");
    assert.strictEqual(first, second);
  });

  it("deeply freezes validated MVP V2 content", () => {
    const profile = loadContractProfile("mvp-v2");
    assertDeepFrozen(profile);
    assert.throws(() => profile.requiredTools.push("invented_tool"), TypeError);
    assert.throws(
      () => {
        profile.tools.search_creators.required[0] = "demand_id";
      },
      TypeError,
    );
  });

  it("loads, caches, and deeply freezes the legacy detection profile", () => {
    const first = loadContractProfile("legacy-1.9.4");
    const second = loadContractProfile("legacy-1.9.4");

    assert.strictEqual(first, second);
    assert.equal(first.mode, "detection-only");
    assert.equal(first.writable, false);
    assertDeepFrozen(first);
  });

  it("rejects unsupported profile names", () => {
    assert.throws(
      () => loadContractProfile("mvp-v3"),
      /unsupported contract profile/i,
    );
  });

  it("rejects path-like profile names without reading them", () => {
    for (const name of ["../mvp-v2", "profiles/mvp-v2", "mvp-v2.json", "..\\mvp-v2"]) {
      assert.throws(() => loadContractProfile(name), /unsupported contract profile/i);
    }
  });

  it("loads, caches, and deeply freezes all auxiliary approved specs", () => {
    const workflow = loadWorkflowContract();
    const database = loadDatabaseContract();
    const errors = loadErrorCatalog();

    assert.strictEqual(workflow, loadWorkflowContract());
    assert.strictEqual(database, loadDatabaseContract());
    assert.strictEqual(errors, loadErrorCatalog());
    assert.equal(workflow.profile, "mvp-v2");
    assert.equal(database.readinessStatus, "external-unverified");
    assert.ok(errors.codes.includes("SCHEMA_MISMATCH"));
    for (const spec of [workflow, database, errors]) assertDeepFrozen(spec);
  });

  it("returns the exact ordered MVP V2 target tool set", () => {
    assert.deepEqual(expectedRequiredTools("mvp-v2"), V2_REQUIRED_TOOLS);
    assert.deepEqual(
      expectedRequiredTools(loadContractProfile("mvp-v2")),
      V2_REQUIRED_TOOLS,
    );
  });

  it("returns the exact observed legacy tool set for detection", () => {
    assert.deepEqual(expectedRequiredTools("legacy-1.9.4"), LEGACY_OBSERVED_TOOLS);
    assert.deepEqual(
      expectedRequiredTools(loadContractProfile("legacy-1.9.4")),
      LEGACY_OBSERVED_TOOLS,
    );
  });
});

describe("tool parameter validation", () => {
  it("accepts the target search_creators requirement identifier", () => {
    assert.deepEqual(
      validateToolParams("search_creators", { requirement_id: "req-1" }),
      [],
    );
  });

  it("reports legacy demand fields before missing target fields", () => {
    const issues = validateToolParams("search_creators", {
      demand_id: "demand-1",
      demand_version: 2,
    });

    assert.ok(issues.length >= 2);
    assert.ok(issues.every((issue) => issue.code === "SCHEMA_MISMATCH"));
    assertHasIssue(issues, "SCHEMA_MISMATCH", "$.demand_id");
    assert.equal(issues.some((issue) => issue.path === "$.requirement_id"), false);
  });

  it("reports unknown target properties before missing required properties", () => {
    const issues = validateToolParams("create_submission_batch", {
      invented_run_identifier: "run-1",
    });

    assert.deepEqual(issues.map((issue) => issue.code), ["SCHEMA_MISMATCH"]);
    assert.equal(issues[0].path, "$.invented_run_identifier");
  });

  it("reports explicitly forbidden fields before missing required properties", () => {
    const issues = validateToolParams("ingest_mcn_submissions", { items: [] });

    assert.deepEqual(issues.map((issue) => issue.code), ["SCHEMA_MISMATCH"]);
    assert.equal(issues[0].path, "$.items");
  });

  it("accepts sync only with its exact two identifiers", () => {
    assert.deepEqual(
      validateToolParams("sync_mcn_inquiry_status", {
        mcn_recommendation_id: "mcn-rec-1",
        requirement_id: "req-1",
      }),
      [],
    );
  });

  it("fails closed for an unknown target tool", () => {
    const issues = validateToolParams("send_invented_distribution", {});
    assertHasIssue(issues, "INTEGRATION_REQUIRED", "$.tool");
  });

  it("fails closed for an unknown profile without throwing", () => {
    let issues;
    assert.doesNotThrow(() => {
      issues = validateToolParams("search_creators", {}, "../mvp-v2");
    });
    assertHasIssue(issues, "INTEGRATION_REQUIRED", "$.profile");
  });

  it("blocks every legacy execution even when its observed schema matches", () => {
    const issues = validateToolParams(
      "search_creators",
      { demand_id: "demand-1", demand_version: 2 },
      "legacy-1.9.4",
    );

    assert.deepEqual(issues.map((issue) => issue.code), ["INTEGRATION_REQUIRED"]);
  });

  it("returns structured invalid-input issues for non-object params", () => {
    for (const params of [null, undefined, "req-1", [], 42]) {
      let issues;
      assert.doesNotThrow(() => {
        issues = validateToolParams("search_creators", params);
      });
      assertHasIssue(issues, "INVALID_INPUT", "$");
    }
  });

  it("enforces required fields", () => {
    const issues = validateToolParams("search_creators", {});
    assertHasIssue(issues, "INVALID_INPUT", "$.requirement_id");
  });

  it("enforces primitive, object, array, and integer types", () => {
    const cases = [
      ["search_creators", { requirement_id: 123 }, "$.requirement_id"],
      ["validate_requirement", validDemand({ requirements_json: [] }), "$.requirements_json"],
      ["create_with_distributions", validDistribution({ supplierIds: "supplier-1" }), "$.supplierIds"],
      ["validate_requirement", validDemand({ quantity_total: 1.5 }), "$.quantity_total"],
    ];

    for (const [tool, params, path] of cases) {
      assertHasIssue(validateToolParams(tool, params), "INVALID_INPUT", path);
    }
  });

  it("enforces const and enum values", () => {
    assertHasIssue(
      validateToolParams(
        "create_with_distributions",
        validDistribution({ usageScope: "campaign", preview_only: true }),
      ),
      "INVALID_INPUT",
      "$.usageScope",
    );
    assertHasIssue(
      validateToolParams("validate_requirement", validDemand({ platform: "wx" })),
      "INVALID_INPUT",
      "$.platform",
    );
  });

  it("enforces nonempty strings", () => {
    const issues = validateToolParams("search_creators", { requirement_id: "" });
    assertHasIssue(issues, "INVALID_INPUT", "$.requirement_id");
  });

  it("enforces array minItems and uniqueItems", () => {
    assertHasIssue(
      validateToolParams(
        "create_with_distributions",
        validDistribution({ supplierIds: [] }),
      ),
      "INVALID_INPUT",
      "$.supplierIds",
    );
    assertHasIssue(
      validateToolParams(
        "create_with_distributions",
        validDistribution({ supplierIds: ["supplier-1", "supplier-1"] }),
      ),
      "INVALID_INPUT",
      "$.supplierIds[1]",
    );
  });

  it("enforces nested required fields and nested additionalProperties", () => {
    const missing = validateToolParams(
      "create_with_distributions",
      validDistribution({ columns: [{ key: "creator_name", type: "text", required: true }] }),
    );
    assertHasIssue(missing, "INVALID_INPUT", "$.columns[0].name");

    const unknown = validateToolParams(
      "create_with_distributions",
      validDistribution({ columns: [{ ...FIELD_ONE, snapshot_id: "snapshot-1" }] }),
    );
    assertHasIssue(unknown, "SCHEMA_MISMATCH", "$.columns[0].snapshot_id");
  });

  it("accepts each complete get_creator_detail identifier alternative", () => {
    assert.deepEqual(
      validateToolParams("get_creator_detail", { creator_id: "creator-1" }),
      [],
    );
    assert.deepEqual(
      validateToolParams("get_creator_detail", {
        platform: "xhs",
        platform_account_id: "account-1",
      }),
      [],
    );
  });

  it("rejects absent, partial, or mixed exactly-one identifier alternatives", () => {
    for (const params of [
      {},
      { platform: "xhs" },
      { creator_id: "creator-1", platform: "xhs" },
      {
        creator_id: "creator-1",
        platform: "xhs",
        platform_account_id: "account-1",
      },
    ]) {
      assertHasIssue(
        validateToolParams("get_creator_detail", params),
        "INVALID_INPUT",
        "$",
      );
    }
  });

  it("enforces exactly one workflow-state identifier alternative", () => {
    assert.deepEqual(
      validateToolParams("get_workflow_state", { inquiry_batch_id: "batch-1" }),
      [],
    );
    assertHasIssue(
      validateToolParams("get_workflow_state", {
        requirement_id: "req-1",
        run_id: "run-1",
      }),
      "INVALID_INPUT",
      "$",
    );
  });
});

describe("field-selection validation", () => {
  it("accepts an exact field map with items as the authoritative order", () => {
    assert.deepEqual(validateFieldSelection(validFieldSelection()), []);
    assert.deepEqual(
      validateFieldSelection(
        validFieldSelection({ items: [{ ...FIELD_TWO }, { ...FIELD_ONE }] }),
      ),
      [],
    );
  });

  it("rejects non-objects, unsuccessful results, envelopes, and top-level inventions", () => {
    for (const result of [
      null,
      { ...validFieldSelection(), success: false },
      { success: true, data: validFieldSelection(), error: null },
      { ...validFieldSelection(), snapshot_id: "snapshot-1" },
      { ...validFieldSelection(), session_id: "session-1" },
    ]) {
      assertHasIssue(validateFieldSelection(result), "FIELD_SELECTION_INVALID");
    }
  });

  it("rejects empty selections, count mismatches, and duplicate keys", () => {
    const cases = [
      validFieldSelection({ fields: {}, items: [], selected_count: 0 }),
      validFieldSelection({ selected_count: 1 }),
      validFieldSelection({
        items: [{ ...FIELD_ONE }, { ...FIELD_ONE }],
      }),
    ];

    for (const result of cases) {
      assertHasIssue(validateFieldSelection(result), "FIELD_SELECTION_INVALID");
    }
  });

  it("rejects array fields and missing, extra, or conflicting map definitions", () => {
    const cases = [
      validFieldSelection({ fields: [{ ...FIELD_ONE }, { ...FIELD_TWO }] }),
      validFieldSelection({ fields: { [FIELD_ONE.key]: { ...FIELD_ONE } } }),
      validFieldSelection({
        fields: {
          [FIELD_ONE.key]: { ...FIELD_ONE },
          [FIELD_TWO.key]: { ...FIELD_TWO },
          extra: { key: "extra", name: "额外", type: "text", required: false },
        },
      }),
      validFieldSelection({ items: [{ ...FIELD_ONE }, { ...FIELD_TWO }, { key: "extra", name: "额外", type: "text", required: false }], selected_count: 3 }),
      validFieldSelection({
        fields: {
          [FIELD_ONE.key]: { ...FIELD_ONE, required: false },
          [FIELD_TWO.key]: { ...FIELD_TWO },
        },
      }),
      validFieldSelection({ items: [{ ...FIELD_ONE, snapshot_id: "snapshot-1" }, { ...FIELD_TWO }] }),
    ];

    for (const result of cases) {
      assertHasIssue(validateFieldSelection(result), "FIELD_SELECTION_INVALID");
    }
  });
});
