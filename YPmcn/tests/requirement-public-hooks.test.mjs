import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { createYpmcnPlugin } from "../dist/index.js";

const rootDir = mkdtempSync(join(tmpdir(), "ypmcn-public-hook-regression-"));
const hooks = new Map();

const QWEN_BRIEF = [
  "品牌：阿里",
  "产品：千问",
  "项目：千问61儿童节生图模板",
  "平台：小红书 图文为主，返点30%+",
  "档期：2026-07-20至2026-07-22",
  "价格：L1单达人3k-1w之内",
  "数量：10",
  "内容：段子梗图表情包、AI深度使用/创作者、颜值或P图攻略、二次元（柯南优先）、明星粉丝P图偶像变小",
  "参考账号：https://example.invalid/qwen-reference",
  "DDL：2026-07-19 11:30提交",
].join("\n");

const DESCRIPTION = "图文为主；段子梗图表情包、AI深度使用/创作者、颜值或P图攻略、二次元（柯南优先）、明星粉丝P图偶像变小";
const EXACT_SEMICOLON_BRIEF = "品牌：阿里巴巴；项目：千问61儿童节；平台：小红书；档期：2026-07-30至2026-07-31；价格：4w以下；返点：30%以上；内容：类似于AI帮忙送儿童节礼物；账号类型：母婴类，亲子相关；数量：5个；提报截止：2026-07-20 11:00。";
const LIVE_BRIEF = [
  "品牌：阿里巴巴",
  "项目：千问61儿童节",
  "平台：小红书",
  "合作形式：图文",
  "档期：7.30-7.31",
  "单价：4w以下",
  "返点：25%以上",
  "内容：类似于AI帮忙送儿童节礼物",
  "账号类型：母婴类，亲子相关",
  "数量：5个",
  "提报时间：7月20号上午11:00",
].join("\n");

function mapped(sourceText, targetField, inferred = false) {
  return { sourceText, disposition: "mapped", targetField, confidence: 1, inferred };
}

function qwenPayload(overrides = {}) {
  const atoms = [
    mapped("品牌：阿里", "brandName"),
    mapped("产品：千问", "product"),
    mapped("项目：千问61儿童节生图模板", "projectName"),
    mapped("平台：小红书 图文为主，返点30%+", "platform"),
    mapped("返点30%+", "rebate"),
    mapped("档期：2026-07-20至2026-07-22", "projectStartStart"),
    mapped("档期：2026-07-20至2026-07-22", "projectStartEnd"),
    mapped("价格：L1单达人3k-1w之内", "kolOfficialPriceL1"),
    mapped("数量：10", "quantityTotal"),
    mapped("内容：段子梗图表情包、AI深度使用/创作者、颜值或P图攻略、二次元（柯南优先）、明星粉丝P图偶像变小", "description"),
    {
      sourceText: "参考账号：https://example.invalid/qwen-reference",
      disposition: "preserved",
      preservedText: "参考账号：https://example.invalid/qwen-reference",
      confidence: 1,
      inferred: false,
    },
    mapped("DDL：2026-07-19 11:30提交", "submissionDeadlineAt"),
  ];
  return {
    status: "ready",
    brandName: "阿里",
    product: "千问",
    projectName: "千问61儿童节生图模板",
    platform: "xiaohongshu",
    quantityTotal: 10,
    projectStartStart: "2026-07-20 00:00:00",
    projectStartEnd: "2026-07-22 23:59:59",
    submissionDeadlineAt: "2026-07-19 11:30:00",
    kolOfficialPriceL1: "[3000,10000]",
    rebate: "[0.3,1]",
    description: DESCRIPTION,
    rawMessagesJson: {
      schemaVersion: "ypmcn-brief-v1",
      originalBrief: QWEN_BRIEF,
      atoms,
      coverageCheck: { atomCount: 12, mappedCount: 11, preservedCount: 1, unresolvedCount: 0 },
    },
    ...overrides,
  };
}

async function newTurn(prompt = QWEN_BRIEF) {
  return hooks.get("before_prompt_build")({ prompt, messages: [] }, {});
}

async function beforeAgentReply(cleanedBody) {
  return hooks.get("before_agent_reply")({ cleanedBody }, { trigger: "user" });
}

async function guard(toolName, params) {
  return hooks.get("before_tool_call")({ toolName, params }, {});
}

function authoritativePayload(result) {
  const marker = "YPmcn authoritative validate_requirement arguments (use this object exactly; do not rebuild any field or audit atom):\n";
  return JSON.parse(result.prependContext.slice(result.prependContext.indexOf(marker) + marker.length).split("\n", 1)[0]).payload;
}

before(() => {
  const template = join(rootDir, "skills", "media-assistant", "assets", "wecom_inquiry_template.txt");
  mkdirSync(dirname(template), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../skills/media-assistant/assets/wecom_inquiry_template.txt", import.meta.url)), template);
  createYpmcnPlugin().register({
    rootDir,
    logger: { error() {} },
    on(name, handler) { hooks.set(name, handler); },
  });
});

after(() => rmSync(rootDir, { recursive: true, force: true }));

describe("requirement behavior through public plugin hooks", () => {
  it("publishes the exact semicolon Brief preview with only the unresolved price gate", async () => {
    const result = await newTurn(EXACT_SEMICOLON_BRIEF);
    const marker = "YPmcn authoritative machine-readable requirement preview (do not recount, remap, or replace):\n";
    const preview = JSON.parse(result.prependContext.slice(result.prependContext.indexOf(marker) + marker.length).split("\n", 1)[0]);

    assert.equal(preview.gate, "semantic_ambiguity");
    assert.deepEqual(preview.missingRequired, []);
    assert.deepEqual(preview.semanticAmbiguities, ["creatorPriceTier"]);
    assert.equal(preview.projection.quantityTotal, 5);
    assert.equal(preview.projection.rebate, "[0.3,1]");
    assert.deepEqual(preview.summary, { atomCount: 11, mappedCount: 9, preservedCount: 1, unresolvedCount: 1 });
    assert.match(result.prependContext, /YPmcn mandatory unresolved-Brief interaction: call native AskUserQuestion now/);
    assert.match(result.prependContext, /<YPmcnClarificationAuthority>[\s\S]*"brandName": "阿里巴巴"[\s\S]*"unresolvedCount": 1[\s\S]*<\/YPmcnClarificationAuthority>/);
  });

  it("makes the live yearless Alibaba Brief ready without taxonomy clarification", async () => {
    const result = await newTurn(LIVE_BRIEF);
    const marker = "YPmcn authoritative machine-readable requirement preview (do not recount, remap, or replace):\n";
    const preview = JSON.parse(result.prependContext.slice(result.prependContext.indexOf(marker) + marker.length).split("\n", 1)[0]);
    const payload = authoritativePayload(result);

    assert.equal(preview.gate, "ready");
    assert.deepEqual(preview.missingRequired, []);
    assert.deepEqual(preview.semanticAmbiguities, []);
    assert.equal(preview.projection.submissionDeadlineAt.slice(5), "07-20 11:00:00");
    assert.equal(preview.projection.kolOfficialPriceL1, "[0,40000]");
    assert.equal(preview.projection.rebate, "[0.25,1]");
    assert.equal(preview.atoms.find((atom) => atom.field === "accountTaxonomy")?.resolution, "preserved");
    assert.equal(payload.status, "ready");
    assert.equal(payload.rawMessagesJson.originalBrief, LIVE_BRIEF);
    assert.equal(payload.rawMessagesJson.atoms.length, 11);
    assert.doesNotMatch(result.prependContext, /YPmcn mandatory unresolved-Brief interaction/);
  });

  it("binds validate_requirement to the Ready Preview and validates every same-turn retry independently", async () => {
    const wrongFirstToolTurn = await newTurn(LIVE_BRIEF);
    const exactFirstPayload = authoritativePayload(wrongFirstToolTurn);
    const wrongFirstTool = await guard("search", { query: "候选达人" });
    assert.match(wrongFirstTool.blockReason, /BLOCKED_REQUIREMENT_VALIDATION_REQUIRED.*only permitted Tool is validate_requirement/);
    const firstToolRetry = await guard("mcp__ypmcn__validate_requirement", { payload: exactFirstPayload });
    assert.equal(firstToolRetry, undefined);

    for (const mutate of [
      (payload) => { delete payload.rawMessagesJson; },
      (payload) => { delete payload.status; },
      (payload) => {
        const rebate = payload.rawMessagesJson.atoms.find((atom) => atom.targetField === "rebate");
        rebate.sourceText = "返点：25以上";
      },
    ]) {
      const result = await newTurn(LIVE_BRIEF);
      const exactPayload = authoritativePayload(result);
      const rebuilt = structuredClone(exactPayload);
      mutate(rebuilt);
      const blocked = await guard("mcp__ypmcn__validate_requirement", { payload: rebuilt });
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_PREVIEW_MISMATCH/);

      const retried = await guard("mcp__ypmcn__validate_requirement", { payload: exactPayload });
      assert.equal(retried, undefined);
    }

    const persisted = readFileSync(join(rootDir, "state", "confirmation_guard.json"), "utf8");
    assert.match(persisted, /"payload_fingerprint": "[0-9a-f]{64}"/);
    assert.doesNotMatch(persisted, /阿里巴巴|千问61儿童节|返点：25%以上/);
  });

  it("requires search_creators.id to equal the latest successful validate_requirement.data.id", async () => {
    const result = await newTurn(LIVE_BRIEF);
    const payload = authoritativePayload(result);
    assert.equal(await guard("mcp__ypmcn__validate_requirement", { payload }), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload },
      result: {
        success: true,
        data: { id: "requirement-row-id", demand_id: "demand-route-id", demand_version: 1 },
        error: null,
      },
    }, {});

    const wrong = await guard("mcp__ypmcn__search_creators", { id: "demand-route-id" });
    assert.match(wrong.blockReason, /ID_PROVENANCE_MISMATCH.*data\.id/);
    const correctedSameTurn = await guard("mcp__ypmcn__search_creators", { id: "requirement-row-id" });
    assert.equal(correctedSameTurn, undefined);
  });

  it("recovers search_creators provenance from authoritative workflow state in the same turn", async () => {
    await newTurn("继续搜索达人");
    const missing = await guard("mcp__ypmcn__search_creators", { id: "requirement-from-state" });
    assert.match(missing.blockReason, /ID_PROVENANCE_(?:REQUIRED|MISMATCH)/);

    assert.equal(await guard("mcp__ypmcn__get_workflow_state", {
      demand_id: "demand-route-id",
      demand_version: 1,
    }), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__get_workflow_state",
      params: { demand_id: "demand-route-id", demand_version: 1 },
      result: {
        success: true,
        data: {
          project_name: "千问61儿童节",
          requirement_id: "requirement-from-state",
          demand_id: "demand-route-id",
          demand_version: 1,
          workflow_state: { phase: "requirement_ready" },
          allowed_actions: ["search_creators"],
        },
        error: null,
      },
    }, {});

    assert.equal(await guard("mcp__ypmcn__search_creators", { id: "requirement-from-state" }), undefined);
  });

  it("shows a same-turn recovery popup after an explicit MCP failure", async () => {
    const result = await newTurn(LIVE_BRIEF);
    const payload = authoritativePayload(result);
    assert.equal(await guard("mcp__ypmcn__validate_requirement", { payload }), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__validate_requirement",
      params: { payload },
      result: { success: true, data: { id: "failed-search-requirement-id" }, error: null },
    }, {});
    assert.equal(await guard("mcp__ypmcn__search_creators", { id: "failed-search-requirement-id" }), undefined);
    await hooks.get("after_tool_call")({
      toolName: "mcp__ypmcn__search_creators",
      params: { id: "failed-search-requirement-id" },
      result: { success: false, data: null, error: { code: "DEMAND_NOT_FOUND" } },
    }, {});

    const recovery = {
      questions: [{
        header: "服务异常",
        question: "后端错误，请稍后再试（DEMAND_NOT_FOUND）。请选择下一步。",
        options: [{ label: "重试一次" }, { label: "停止" }],
      }],
    };
    assert.equal(await guard("AskUserQuestion", recovery), undefined);
    await hooks.get("after_tool_call")({
      toolName: "AskUserQuestion",
      params: recovery,
      result: `${recovery.questions[0].question}: 重试一次`,
    }, {});
    assert.equal(await guard("mcp__ypmcn__search_creators", { id: "failed-search-requirement-id" }), undefined);
  });

  it("routes unresolved standard Briefs to a native popup instead of a text-only stop", async () => {
    const result = await beforeAgentReply(`请按权威预览解析，确认前不要调用任何 Tool。${EXACT_SEMICOLON_BRIEF}`);
    assert.equal(result, undefined);
    const prompt = await newTurn(EXACT_SEMICOLON_BRIEF);
    assert.match(prompt.prependContext, /call native AskUserQuestion now/);

    assert.equal(await guard("AskUserQuestion", {
      questions: [{
        header: "报价口径",
        question: "4万元指哪种报价？",
        multiSelect: false,
        options: [
          { label: "项目总预算", description: "整个项目合计不超过4万元" },
          { label: "单达人图文", description: "每位达人图文报价不超过4万元" },
          { label: "单达人视频", description: "每位达人视频报价不超过4万元" },
        ],
      }],
    }), undefined);

    const blocked = await guard("ypmcn-mcp__prompts_get", { name: "AskUserQuestion" });
    assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_CLARIFICATION_REQUIRED/);
  });

  it("accepts the exact Alibaba/Qwen values with full datetimes and schema-native integer/range types", async () => {
    await newTurn();
    const payload = qwenPayload();
    assert.deepEqual({
      brandName: payload.brandName,
      product: payload.product,
      projectName: payload.projectName,
      platform: payload.platform,
      quantityTotal: payload.quantityTotal,
      projectStartStart: payload.projectStartStart,
      projectStartEnd: payload.projectStartEnd,
      submissionDeadlineAt: payload.submissionDeadlineAt,
      kolOfficialPriceL1: payload.kolOfficialPriceL1,
      rebate: payload.rebate,
    }, {
      brandName: "阿里",
      product: "千问",
      projectName: "千问61儿童节生图模板",
      platform: "xiaohongshu",
      quantityTotal: 10,
      projectStartStart: "2026-07-20 00:00:00",
      projectStartEnd: "2026-07-22 23:59:59",
      submissionDeadlineAt: "2026-07-19 11:30:00",
      kolOfficialPriceL1: "[3000,10000]",
      rebate: "[0.3,1]",
    });
    assert.equal(await guard("mcp__ypmcn__validate_requirement", { payload }), undefined);

    for (const [field, value, reason] of [
      ["quantityTotal", "[10,10]", /quantityTotal|integer/i],
      ["submissionDeadlineAt", "2026-07-19T11:30:00", /submissionDeadlineAt|YYYY-MM-DD HH:mm:ss/],
      ["projectStartEnd", "2026-07-22", /projectStartEnd|YYYY-MM-DD HH:mm:ss/],
      ["kolOfficialPriceL1", [3000, 10000], /kolOfficialPriceL1|range string/],
      ["rebate", [0.3, 1], /rebate|string/],
    ]) {
      await newTurn(`invalid ${field}`);
      const blocked = await guard("mcp__ypmcn__validate_requirement", {
        payload: qwenPayload({ [field]: value }),
      });
      assert.equal(blocked?.block, true, `${field} must fail closed`);
      assert.match(blocked.blockReason, reason, `${field} should identify its type/format defect`);
    }
  });

  it("permits only legal mapped/preserved dispositions and one real targetField per mapped atom", async () => {
    await newTurn();
    assert.equal(await guard("mcp__ypmcn__validate_requirement", { payload: qwenPayload() }), undefined);

    const cases = [
      ["combined targetField", (payload) => { payload.rawMessagesJson.atoms[8].targetField = "quantityTotal,rebate"; }, /targetField/],
      ["targetField array", (payload) => { payload.rawMessagesJson.atoms[8].targetField = ["quantityTotal"]; }, /targetField/],
      ["invented targetField", (payload) => { payload.rawMessagesJson.atoms[8].targetField = "quantityRange"; }, /targetField/],
      ["unresolved disposition", (payload) => { payload.rawMessagesJson.atoms[8].disposition = "semantic_ambiguity"; }, /disposition/],
      ["preserved without exact preservedText", (payload) => { payload.rawMessagesJson.atoms[10].preservedText = "reference"; }, /preservedText/],
    ];
    for (const [name, mutate, reason] of cases) {
      await newTurn(name);
      const payload = qwenPayload();
      mutate(payload);
      const blocked = await guard("mcp__ypmcn__validate_requirement", { payload });
      assert.equal(blocked?.block, true, name);
      assert.match(blocked.blockReason, reason, name);
    }
  });

  it("derives coverage exactly from the same atom list", async () => {
    for (const [name, coverageCheck] of [
      ["wrong atom total", { atomCount: 11, mappedCount: 11, preservedCount: 1, unresolvedCount: 0 }],
      ["wrong mapped total", { atomCount: 12, mappedCount: 10, preservedCount: 1, unresolvedCount: 0 }],
      ["wrong preserved total", { atomCount: 12, mappedCount: 11, preservedCount: 0, unresolvedCount: 0 }],
      ["hidden unresolved atom", { atomCount: 12, mappedCount: 11, preservedCount: 1, unresolvedCount: 1 }],
    ]) {
      await newTurn(name);
      const payload = qwenPayload();
      payload.rawMessagesJson.coverageCheck = coverageCheck;
      const blocked = await guard("mcp__ypmcn__validate_requirement", { payload });
      assert.equal(blocked?.block, true, name);
      assert.match(blocked.blockReason, /BLOCKED_REQUIREMENT_AUDIT_CONFLICT.*derived from the same atoms/, name);
    }
  });

  it("preserves price ambiguity while accepting explicit account taxonomy", async () => {
    await newTurn("ambiguous unit price");
    const price = qwenPayload();
    delete price.kolOfficialPriceL1;
    price.rawMessagesJson.originalBrief = price.rawMessagesJson.originalBrief.replace(
      "价格：L1单达人3k-1w之内",
      "价格：3k-1w之内",
    );
    price.rawMessagesJson.atoms[7] = {
      sourceText: "价格：3k-1w之内",
      disposition: "preserved",
      preservedText: "价格：3k-1w之内",
      confidence: 1,
      inferred: false,
    };
    price.rawMessagesJson.coverageCheck = { atomCount: 12, mappedCount: 10, preservedCount: 2, unresolvedCount: 0 };
    const priceBlocked = await guard("mcp__ypmcn__validate_requirement", { payload: price });
    assert.match(priceBlocked.blockReason, /single-creator budget|kolOfficialPriceL1\/L2\/L3/);

    await newTurn("账号类型：母婴类、亲子相关");
    const taxonomy = qwenPayload({ talentTypeLabel: ["母婴", "亲子"] });
    taxonomy.rawMessagesJson.originalBrief += "\n账号类型：母婴类、亲子相关";
    taxonomy.rawMessagesJson.atoms.push(mapped("账号类型：母婴类、亲子相关", "talentTypeLabel"));
    taxonomy.rawMessagesJson.coverageCheck = { atomCount: 13, mappedCount: 12, preservedCount: 1, unresolvedCount: 0 };
    assert.equal(await guard("mcp__ypmcn__validate_requirement", { payload: taxonomy }), undefined);

    await newTurn("semantic ambiguity must not be submitted");
    const draftBlocked = await guard("mcp__ypmcn__validate_requirement", {
      payload: qwenPayload({ status: "semantic_ambiguity" }),
    });
    assert.match(draftBlocked.blockReason, /BLOCKED_REQUIREMENT_INCOMPLETE.*status must be ready/);
  });

  it("publishes the popup clarification and deterministic output contract", async () => {
    const prompt = await newTurn("账号类型和价格需要澄清");
    const contract = prompt.prependSystemContext;
    assert.match(contract, /Use only installed YPmcn MCP tools/);
    assert.match(contract, /do not read Skill files, probe schemas, inspect config, call get_workflow_state, or try another business tool first/);
    assert.match(contract, /missing_required and semantic_ambiguity.*inside that popup.*without status "ready" and without calling validate_requirement/);
    assert.match(contract, /Requirement clarification must immediately use one self-contained native AskUserQuestion popup/);
    assert.match(contract, /at most five concise questions/);
    assert.match(contract, /host provides typed input/);
    assert.match(contract, /Preview atom details, gate, and summary must be rendered from one in-memory atom list/);
    assert.match(contract, /summary\.unresolvedCount counts missing_required plus semantic_ambiguity rows/);
    assert.match(contract, /ready must show the exact tool arguments as \{"payload": \{\.\.\., "status": "ready"\}\}/);

    assert.equal(await guard("AskUserQuestion", {
      questions: [{
        header: "报价口径",
        question: "4万元指哪种报价？",
        multiSelect: false,
        options: [
          { label: "单达人图文", description: "每位达人图文报价不超过4万元" },
          { label: "项目总预算", description: "整个项目合计不超过4万元" },
        ],
      }],
    }), undefined, "the host-native confirmation tool remains available");
  });

  it("allows corrected read-only calls without requiring a new prompt turn", async () => {
    await newTurn("first turn");
    const invalid = await guard("mcp__ypmcn__get_workflow_state", { demand_id: "demand-qwen" });
    assert.match(invalid.blockReason, /INVALID_INPUT/);
    assert.equal(await guard("mcp__ypmcn__get_workflow_state", { trace_id: "trace-qwen" }), undefined);

    await newTurn("用户补充后开启新一轮");
    assert.equal(await guard("mcp__ypmcn__get_workflow_state", { trace_id: "trace-qwen" }), undefined);
  });

  it("stops after a blocked Tool and requires get_workflow_state first for send recovery", async () => {
    const prompt = await newTurn("resume Qwen distribution");
    assert.match(prompt.prependSystemContext, /use it only when taking over an existing demand, after context loss\/state conflict\/unknown write result/);
    assert.match(prompt.prependSystemContext, /Before create_with_distributions, first reconcile get_workflow_state/);

    const params = {
      projectName: "千问61儿童节生图模板",
      deadline: "2099-07-19T11:30:00+08:00",
      columns: [{ field_key: "creator_name", field_name: "达人名称" }],
      supplierIds: ["supplier-qwen"],
      prefillRows: [],
      prefillRowsBySupplier: { "supplier-qwen": [] },
    };
    const blockedSend = await guard("mcp__ypmcn__create_with_distributions", params);
    assert.match(blockedSend.blockReason, /WORKFLOW_STATE_REFRESH_REQUIRED.*get_workflow_state/);
    assert.equal(await guard("mcp__ypmcn__get_workflow_state", {
      demand_id: "demand-qwen",
      demand_version: 1,
    }), undefined, "the required recovery read is allowed after the continuation block");
  });
});
