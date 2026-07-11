import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as contractLoader from "../dist/contract/loader.js";
import {
  validateFieldSelection,
  validateToolParams,
} from "../dist/contract/validator.js";

const {
  expectedRequiredTools,
  loadContractProfile,
  loadDatabaseContract,
  loadErrorCatalog,
  loadWorkflowContract,
} = contractLoader;

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

const DOCUMENTED_FIELD_SELECTION = {
  success: true,
  url: "http://127.0.0.1:8000/demand-field-selector",
  message: "已接收需求字段选择结果",
  description:
    "friendcount：关注数\npostcount：作品数\nsumpost：累计作品数\nsumpost_bussiness：商业作品数\nuserfavoritscount：收藏数\nuserlikecount：获赞数",
  fields: {
    friendcount: { key: "friendcount", name: "关注数", type: "BIGINT", required: true },
    postcount: { key: "postcount", name: "作品数", type: "BIGINT", required: true },
    sumpost: { key: "sumpost", name: "累计作品数", type: "BIGINT", required: true },
    sumpost_bussiness: {
      key: "sumpost_bussiness",
      name: "商业作品数",
      type: "BIGINT",
      required: true,
    },
    userfavoritscount: {
      key: "userfavoritscount",
      name: "收藏数",
      type: "BIGINT",
      required: true,
    },
    userlikecount: {
      key: "userlikecount",
      name: "获赞数",
      type: "BIGINT",
      required: true,
    },
  },
  items: [
    { key: "friendcount", name: "关注数", type: "BIGINT", required: true },
    { key: "postcount", name: "作品数", type: "BIGINT", required: true },
    { key: "sumpost", name: "累计作品数", type: "BIGINT", required: true },
    {
      key: "sumpost_bussiness",
      name: "商业作品数",
      type: "BIGINT",
      required: true,
    },
    {
      key: "userfavoritscount",
      name: "收藏数",
      type: "BIGINT",
      required: true,
    },
    { key: "userlikecount", name: "获赞数", type: "BIGINT", required: true },
  ],
  selected_count: 6,
  output_format: "数据库字段名：字段备注",
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

  it("exposes reusable parsed-document validation without widening profile loading", () => {
    assert.equal(
      typeof contractLoader.validateContractProfileDocument,
      "function",
      "loader must expose typed document validation for isolated fixtures",
    );
    assert.throws(() => loadContractProfile("constructor"), /unsupported contract profile/i);
  });

  it("runtime allowlists parsed-document profile names", () => {
    for (const name of [
      "mvp-v3",
      "../mvp-v2",
      "profiles/mvp-v2",
      "mvp-v2.json",
      "..\\mvp-v2",
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      assert.throws(
        () => contractLoader.validateContractProfileDocument(name, {}),
        /unsupported contract profile/i,
        name,
      );
    }
  });

  it("returns independent deeply frozen parsed-document snapshots", () => {
    const input = structuredClone(loadContractProfile("mvp-v2"));
    const first = contractLoader.validateContractProfileDocument("mvp-v2", input);
    const second = contractLoader.validateContractProfileDocument("mvp-v2", input);

    assert.notStrictEqual(first, input);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.tools, input.tools);
    assert.notStrictEqual(first.tools.search_creators, input.tools.search_creators);
    assertDeepFrozen(first);

    input.requiredTools[0] = "mutated_after_validation";
    input.tools.search_creators.required[0] = "mutated_after_validation";
    assert.equal(first.requiredTools[0], V2_REQUIRED_TOOLS[0]);
    assert.equal(first.tools.search_creators.required[0], "requirement_id");
    assert.throws(() => first.requiredTools.push("mutated_result"), TypeError);
    assert.throws(
      () => {
        first.tools.search_creators.required[0] = "mutated_result";
      },
      TypeError,
    );

    assert.strictEqual(
      loadContractProfile("mvp-v2"),
      loadContractProfile("mvp-v2"),
      "canonical loader cache identity must remain stable",
    );
  });

  it("rejects duplicate, overlapping, missing, extra, and malformed MVP tool declarations", () => {
    const validateDocument = contractLoader.validateContractProfileDocument;
    assert.equal(typeof validateDocument, "function");
    const mutations = [
      {
        label: "duplicate required tool",
        mutate: (profile) => profile.requiredTools.push(profile.requiredTools[0]),
      },
      {
        label: "duplicate optional tool",
        mutate: (profile) => profile.optionalTools.push(profile.optionalTools[0]),
      },
      {
        label: "required/optional overlap",
        mutate: (profile) => profile.optionalTools.push(profile.requiredTools[0]),
      },
      {
        label: "missing tool-map key",
        mutate: (profile) => delete profile.tools[profile.requiredTools[0]],
      },
      {
        label: "extra tool-map key",
        mutate: (profile) => {
          profile.tools.extra_tool = structuredClone(profile.tools.search_creators);
          profile.tools.extra_tool.name = "extra_tool";
        },
      },
      {
        label: "inherited prototype name is not a tool-map key",
        mutate: (profile) => profile.requiredTools.push("constructor"),
      },
      {
        label: "missing writable forbidden array",
        mutate: (profile) => delete profile.tools.search_creators.forbidden,
      },
      {
        label: "malformed writable forbidden array",
        mutate: (profile) => {
          profile.tools.search_creators.forbidden = "demand_id";
        },
      },
    ];

    for (const { label, mutate } of mutations) {
      const profile = structuredClone(loadContractProfile("mvp-v2"));
      mutate(profile);
      assert.throws(
        () => validateDocument("mvp-v2", profile),
        Error,
        label,
      );
    }
  });

  it("rejects duplicate, missing, extra, and inherited legacy observed tool declarations", () => {
    const validateDocument = contractLoader.validateContractProfileDocument;
    assert.equal(typeof validateDocument, "function");
    const mutations = [
      {
        label: "duplicate observed tool",
        mutate: (profile) => {
          profile.observedSummary.toolNames.push(profile.observedSummary.toolNames[0]);
        },
      },
      {
        label: "missing observed tool-map key",
        mutate: (profile) => {
          delete profile.observedSummary.tools[profile.observedSummary.toolNames[0]];
        },
      },
      {
        label: "extra observed tool-map key",
        mutate: (profile) => {
          const tools = profile.observedSummary.tools;
          tools.extra_tool = structuredClone(tools.search_creators);
          tools.extra_tool.name = "extra_tool";
        },
      },
      {
        label: "inherited prototype name is not an observed tool-map key",
        mutate: (profile) => profile.observedSummary.toolNames.push("toString"),
      },
    ];

    for (const { label, mutate } of mutations) {
      const profile = structuredClone(loadContractProfile("legacy-1.9.4"));
      mutate(profile);
      assert.throws(
        () => validateDocument("legacy-1.9.4", profile),
        Error,
        label,
      );
    }
  });

  it("enforces every detection-only legacy tool capability and zero-writer invariant", () => {
    const validateDocument = contractLoader.validateContractProfileDocument;
    const mutations = [
      {
        label: "missing capability",
        mutate: (tool) => delete tool.capability,
      },
      {
        label: "changed capability",
        mutate: (tool) => {
          tool.capability = "writable";
        },
      },
      {
        label: "missing executable",
        mutate: (tool) => delete tool.executable,
      },
      {
        label: "executable legacy tool",
        mutate: (tool) => {
          tool.executable = true;
        },
      },
      {
        label: "missing writer authorization",
        mutate: (tool) => delete tool.writerAuthorization,
      },
      {
        label: "changed writer authorization",
        mutate: (tool) => {
          tool.writerAuthorization = "business-write";
        },
      },
      {
        label: "missing writers",
        mutate: (tool) => delete tool.writers,
      },
      {
        label: "changed writers",
        mutate: (tool) => {
          tool.writers = "none";
        },
      },
      {
        label: "missing always-writer array",
        mutate: (tool) => delete tool.writers.always,
      },
      {
        label: "malformed always-writer array",
        mutate: (tool) => {
          tool.writers.always = "customer_demands";
        },
      },
      {
        label: "malformed conditional-writer array",
        mutate: (tool) => {
          tool.writers.conditional = { table: "customer_demands" };
        },
      },
      {
        label: "authorized always-writer",
        mutate: (tool) => tool.writers.always.push("customer_demands"),
      },
      {
        label: "authorized conditional-writer",
        mutate: (tool) => tool.writers.conditional.push("customer_demands"),
      },
    ];

    for (const { label, mutate } of mutations) {
      const profile = structuredClone(loadContractProfile("legacy-1.9.4"));
      mutate(profile.observedSummary.tools.search_creators);
      assert.throws(
        () => validateDocument("legacy-1.9.4", profile),
        Error,
        label,
      );
    }
  });

  it("publishes a legacy observed-tool type without writable-only forbidden fields", () => {
    const declarations = readFileSync(
      new URL("../dist/contract/types.d.ts", import.meta.url),
      "utf8",
    );
    const legacyType = declarations.match(
      /export interface LegacyObservedToolContract \{([\s\S]*?)\n\}/,
    );

    assert.ok(legacyType, "LegacyObservedToolContract declaration is missing");
    assert.doesNotMatch(legacyType[1], /\bforbidden\b/);
    assert.match(
      declarations,
      /tools: Record<string, LegacyObservedToolContract>;/,
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

  it("fails closed for inherited Object prototype tool names", () => {
    for (const tool of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assertHasIssue(validateToolParams(tool, {}), "INTEGRATION_REQUIRED", "$.tool");
    }
  });

  it("rejects JSON-own Object prototype names as undeclared target params", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const params = JSON.parse(
        `{"requirement_id":"req-1","${name}":"unexpected"}`,
      );
      assert.equal(Object.hasOwn(params, name), true);
      assertHasIssue(
        validateToolParams("search_creators", params),
        "SCHEMA_MISMATCH",
        `$.${name}`,
      );
    }
  });

  it("validates prototype-named own values through additionalProperties schemas", () => {
    const prefillRowsBySupplier = JSON.parse('{"constructor":"not-an-array"}');
    assert.equal(Object.hasOwn(prefillRowsBySupplier, "constructor"), true);
    assertHasIssue(
      validateToolParams(
        "create_with_distributions",
        validDistribution({ prefillRowsBySupplier }),
      ),
      "INVALID_INPUT",
      "$.prefillRowsBySupplier.constructor",
    );
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

  it("accepts the documented successful selector response with display metadata", () => {
    assert.deepEqual(validateFieldSelection(DOCUMENTED_FIELD_SELECTION), []);
  });

  it("keeps the machine envelope and runtime field-selection validator consistent", () => {
    const profile = loadContractProfile("mvp-v2");
    const envelope = profile.outputEnvelopes["top-level-field-selection"];

    assert.deepEqual(Object.keys(envelope.properties), [
      "success",
      "url",
      "message",
      "description",
      "fields",
      "items",
      "selected_count",
      "output_format",
    ]);
    assert.equal(envelope.additionalProperties, false);
    assert.equal(envelope.properties.fields.type, "object");
    assert.equal(envelope.properties.items.type, "array");
    assert.equal(envelope.properties.items.ordered, true);
    assert.deepEqual(
      envelope.properties.fields.additionalProperties,
      envelope.properties.items.items,
    );
    assert.deepEqual(validateFieldSelection(DOCUMENTED_FIELD_SELECTION), []);
  });

  it("validates documented display metadata as strings", () => {
    for (const key of ["url", "message", "description", "output_format"]) {
      const issues = validateFieldSelection({
        ...DOCUMENTED_FIELD_SELECTION,
        [key]: 42,
      });
      const displayIssue = issues.find((candidate) => candidate.path === `$.${key}`);
      assert.ok(displayIssue, `${key} must produce a field-selection issue`);
      assert.match(displayIssue.message, /string/i);
    }
  });

  it("rejects non-objects, unsuccessful results, envelopes, and top-level inventions", () => {
    for (const result of [
      null,
      { ...validFieldSelection(), success: false },
      { success: true, data: validFieldSelection(), error: null },
      { ...validFieldSelection(), snapshot_id: "snapshot-1" },
      { ...validFieldSelection(), session_id: "session-1" },
      { ...validFieldSelection(), selection_session_id: "selection-1" },
      { ...validFieldSelection(), invented_display_key: "invented" },
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
